import {ShaderChunk, Vector3, Vector4} from 'three';

// A primitive can end on the very same atlas edge as a different surface.
// Padding cannot occupy either side. Only guard coincident straight UV edges
// with different model-space endpoints, leaving continuous texture charts alone.
export function touchingPaintBounds(root, materialName) {
  const edges = new Map(), bounds = new Map();
  const world = new Vector3();
  const primitives = [];
  root.traverse(mesh => {
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    if ((mesh.material.userData.sourceMaterial || mesh.material.name) === materialName &&
        mesh.geometry.attributes.uv?.count) primitives.push(mesh);
  });
  if (primitives.length < 2) return bounds;
  root.updateMatrixWorld(true);
  // Most atlas rectangles have free space between them. Only inspect triangle
  // edges if another primitive actually ends at the opposite side of this bound.
  const limitSets = Array.from({length:4}, () => new Set());
  const rectangles = primitives.map(mesh => {
    const {uv} = mesh.geometry.attributes;
    const limits = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      limits[0] = Math.min(u, limits[0]); limits[2] = Math.max(u, limits[2]);
      limits[1] = Math.min(v, limits[1]); limits[3] = Math.max(v, limits[3]);
    }
    limits.forEach((value,i) => limitSets[i].add(value));
    return limits;
  });
  primitives.forEach((mesh,id) => {
    const limits = rectangles[id];
    const touches = limits.map((value,i) => limitSets[(i+2)%4].has(value));
    if (!touches.some(Boolean)) return;
    const {uv, position} = mesh.geometry.attributes;
    const point = vertex => world.fromBufferAttribute(position,vertex).applyMatrix4(mesh.matrixWorld).clone();
    const index = mesh.geometry.index;
    const count = index ? index.count : uv.count;
    for (let i = 0; i < count; i += 3) {
      for (let j = 0; j < 3; j++) {
        let a = i+j, b = i+(j+1)%3;
        if (index) { a = index.getX(a); b = index.getX(b); }
        const u = uv.getX(a), v = uv.getY(a);
        const axis = u === uv.getX(b) ? 0 : v === uv.getY(b) ? 1 : -1;
        if (axis < 0) continue;
        const at = axis ? v : u;
        const side = at === limits[axis] ? axis : at === limits[axis+2] ? axis+2 : -1;
        if (side < 0 || !touches[side]) continue;
        const start = axis ? u : v, end = axis ? uv.getX(b) : uv.getY(b);
        if (start === end) continue;
        const key = [axis, at, Math.min(start,end), Math.max(start,end)].join('/');
        const first = point(start < end ? a : b), last = point(start < end ? b : a);
        const matches = edges.get(key) || [];
        for (const other of matches) {
          if (other.mesh === mesh || other.side === side || (first.equals(other.first) && last.equals(other.last))) continue;
          for (const [part, edge] of [[other.mesh,other.side],[mesh,side]]) {
            if (!bounds.has(part)) bounds.set(part, new Vector4(-2,-2,3,3));
            bounds.get(part).setComponent(edge,at);
          }
        }
        matches.push({mesh,side,first,last});
        edges.set(key,matches);
      }
    }
  });
  return bounds;
}

// UV derivatives for the normal's tangent frame must still use the original UV.
// Constrain only the texture lookup, retaining gradients for mip selection.
export function installPaintContactFilter(material, bounds) {
  material.onBeforeCompile = shader => {
    if (!material.defines?.PAINT_CONTACT_COLOR && !material.defines?.PAINT_CONTACT_NORMAL) return;
    shader.uniforms.paintContactBounds = {value:bounds};
    shader.fragmentShader = `
      uniform vec4 paintContactBounds;
      vec4 readPaintIsland(sampler2D atlas, vec2 uv) {
        vec2 size = vec2(textureSize(atlas,0));
        vec2 dx = dFdx(uv), dy = dFdy(uv);
        vec2 footprint = abs(dx) + abs(dy);
        vec2 extra = max(footprint - 0.5/size, vec2(0.0));
        vec2 lo = (ceil(paintContactBounds.xy*size-0.5)+0.5)/size + extra;
        vec2 hi = (ceil(paintContactBounds.zw*size-0.5)-0.5)/size - extra;
        vec2 safe = clamp(uv,min(lo,(lo+hi)*0.5),max(hi,(lo+hi)*0.5));
        return textureGrad(atlas,safe,dx,dy);
      }
    ` + shader.fragmentShader;
    for (const [flag,chunk,lookup] of [
      ['PAINT_CONTACT_COLOR','map_fragment','map, vMapUv'],
      ['PAINT_CONTACT_NORMAL','normal_fragment_maps','normalMap, vNormalMapUv']
    ]) {
      if (!material.defines?.[flag]) continue;
      shader.fragmentShader = shader.fragmentShader.replace('#include <'+chunk+'>',
        ShaderChunk[chunk].replaceAll('texture2D( '+lookup+' )','readPaintIsland( '+lookup+' )'));
    }
  };
}
