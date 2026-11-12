import {Vector3} from 'three';

export function smoothSelectedVertices(primitives, selected, {factor, iterations, axes, keepBoundary}) {
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1 ||
      !Number.isInteger(iterations) || iterations < 1 || iterations > 20 ||
      axes.length !== 3 || !axes.some(Boolean)) throw Error('请输入有效的平滑参数并选择至少一个轴');
  const positions = new Map(), neighbors = new Map(), triangles = [];
  for (const id of selected) neighbors.set(id, new Map());
  for (const {geometry, topology} of primitives) {
    const {vertices, faces} = topology;
    if (!faces) throw Error('原拓扑未就绪，请重新打开工程后重试');
    const attribute = geometry.attributes.position;
    for (const {triangles: indices, edges} of faces.values()) {
      for (const [left, right] of edges) {
        const a = vertices[left], b = vertices[right];
        if (a === b) continue;
        for (const [from, to] of [[a, b], [b, a]]) {
          const edgesAtVertex = neighbors.get(from);
          if (edgesAtVertex) edgesAtVertex.set(to, (edgesAtVertex.get(to) || 0) + 1);
        }
      }
      for (let index = 0; index < indices.length; index += 3) {
        const face = indices.slice(index, index + 3);
        if (!face.some(vertex => selected.has(vertices[vertex]))) continue;
        const ids = face.map(vertex => vertices[vertex]);
        face.forEach((vertex, i) => {
          if (!positions.has(ids[i])) positions.set(ids[i], new Vector3().fromBufferAttribute(attribute, vertex));
        });
        triangles.push(ids);
      }
    }
  }
  const movable = [...neighbors].filter(([,edges]) => edges.size &&
    (!keepBoundary || [...edges.values()].every(count => count === 2)));
  let current = new Map();
  for (let i = 0; i < iterations; i++) {
    const next = new Map();
    for (const [id, edges] of movable) {
      const average = new Vector3(), before = current.get(id) ?? positions.get(id);
      for (const neighbor of edges.keys()) average.add(current.get(neighbor) ?? positions.get(neighbor));
      average.divideScalar(edges.size);
      const after = before.clone();
      axes.forEach((enabled, axis) => {
        if (enabled) after.setComponent(axis, before.getComponent(axis) + factor * (average.getComponent(axis) - before.getComponent(axis)));
      });
      next.set(id, after);
    }
    current = next;
  }
  for (const [id, value] of current) {
    value.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
    if (value.equals(positions.get(id))) current.delete(id);
  }
  const normal = ([a, b, c]) => b.clone().sub(a).cross(c.clone().sub(a));
  for (const ids of triangles) {
    if (!ids.some(id => current.has(id))) continue;
    const original = normal(ids.map(id => positions.get(id)));
    if (original.lengthSq() === 0) continue;
    const changed = normal(ids.map(id => current.get(id) ?? positions.get(id)));
    if (changed.dot(original) <= 0 || changed.lengthSq() < original.lengthSq() * 1e-12)
      throw Error('平滑会折叠部分面，请减小系数或重复次数');
  }
  return current;
}
