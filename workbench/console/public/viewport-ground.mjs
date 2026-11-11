import * as THREE from 'three';

// Reconstruct a world-space plane per pixel. Helpers then retain their extent
// while the model keeps its narrow, high precision depth range.
const planeUniforms = `
  varying vec2 vPlaneNdc;
  uniform mat4 planeInverseProjection;
  uniform mat4 planeCameraWorld;
  uniform mat4 planeViewProjection;
  uniform vec3 planeEye;
  uniform float planeNear;
  uniform bool planeOrthographic;
  uniform float planeHeight;
`;

const intersectPlane = `
  vec4 planeNearPoint = planeInverseProjection * vec4(vPlaneNdc, -1.0, 1.0);
  vec4 planeFarPoint = planeInverseProjection * vec4(vPlaneNdc, 1.0, 1.0);
  vec3 planeStart = (planeCameraWorld * vec4(planeNearPoint.xyz / planeNearPoint.w, 1.0)).xyz;
  vec3 planeEnd = (planeCameraWorld * vec4(planeFarPoint.xyz / planeFarPoint.w, 1.0)).xyz;
  vec3 planeRay = normalize(planeEnd - planeStart);
  vec3 planeOrigin = planeOrthographic ? planeStart - planeRay * planeNear : planeEye;
  if (abs(planeRay.y) < 0.00001) discard;
  float planeDistance = (planeHeight - planeOrigin.y) / planeRay.y;
  if (planeDistance <= 0.0) discard;
  vec3 planePoint = planeOrigin + planeRay * planeDistance;
  vec4 planeClip = planeViewProjection * vec4(planePoint, 1.0);
  gl_FragDepth = clamp(planeClip.z / planeClip.w * 0.5 + 0.5, 0.0, 1.0);
`;

function uniforms() {
  return {
    planeInverseProjection: {value: new THREE.Matrix4()},
    planeCameraWorld: {value: new THREE.Matrix4()},
    planeViewProjection: {value: new THREE.Matrix4()},
    planeEye: {value: new THREE.Vector3()},
    planeNear: {value: 0},
    planeOrthographic: {value: false},
    planeHeight: {value: 0}
  };
}

function updateCamera(values, camera, height) {
  values.planeInverseProjection.value.copy(camera.projectionMatrixInverse);
  values.planeCameraWorld.value.copy(camera.matrixWorld);
  values.planeViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  values.planeEye.value.setFromMatrixPosition(camera.matrixWorld);
  values.planeNear.value = camera.near;
  values.planeOrthographic.value = !!camera.isOrthographicCamera;
  values.planeHeight.value = height;
}

export function createInfiniteGround() {
  const values = uniforms();
  const material = new THREE.MeshStandardMaterial({roughness: .7, side: THREE.DoubleSide});
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, values);
    shader.vertexShader = 'varying vec2 vPlaneNdc;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvPlaneNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0);'
    );
    // Stock PBR lighting, reflection and shadows use the reconstructed point.
    const normalDeclarations = THREE.ShaderChunk.normal_pars_fragment.replace('varying vec3 vNormal;', 'vec3 vNormal;');
    const shadowDeclarations = THREE.ShaderChunk.shadowmap_pars_fragment.replaceAll('varying vec4', 'vec4');
    shader.fragmentShader = planeUniforms + `
      #if NUM_DIR_LIGHT_SHADOWS > 0
        uniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];
      #endif
    ` + shader.fragmentShader
      .replace('varying vec3 vViewPosition;', 'vec3 vViewPosition;')
      .replace('#include <normal_pars_fragment>', normalDeclarations)
      .replace('#include <shadowmap_pars_fragment>', shadowDeclarations)
      .replace('void main() {', `void main() {
        ${intersectPlane}
        vViewPosition = -(viewMatrix * vec4(planePoint, 1.0)).xyz;
        vNormal = normalize(mat3(viewMatrix) * vec3(0.0, planeRay.y < 0.0 ? 1.0 : -1.0, 0.0));
        #if NUM_DIR_LIGHT_SHADOWS > 0
          #pragma unroll_loop_start
          for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
            vDirectionalShadowCoord[i] = directionalShadowMatrix[i] * vec4(planePoint, 1.0);
          }
          #pragma unroll_loop_end
        #endif
      `);
  };
  material.customProgramCacheKey = () => 'arachne-infinite-ground-v1';
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'Viewport ground';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.raycast = () => {};
  mesh.onBeforeRender = (renderer, scene, camera) => updateCamera(values, camera, mesh.userData.height || 0);
  return mesh;
}

export function createInfiniteGrid() {
  const color = new THREE.Color('#858585'), renderColor = new THREE.Color('#cccccc');
  const values = {
    ...uniforms(),
    gridStep: {value: 1},
    gridFade: {value: 100},
    gridCenter: {value: new THREE.Vector2()},
    gridColor: {value: color}
  };
  const material = new THREE.ShaderMaterial({
    uniforms: values,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `varying vec2 vPlaneNdc;
      void main() { vPlaneNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `${planeUniforms}
      uniform float gridStep;
      uniform float gridFade;
      uniform vec2 gridCenter;
      uniform vec3 gridColor;
      float lines(vec2 point) {
        vec2 footprint = max(fwidth(point), vec2(0.00001));
        vec2 distanceToLine = abs(fract(point - 0.5) - 0.5) / footprint;
        return 1.0 - min(min(distanceToLine.x, distanceToLine.y), 1.0);
      }
      void main() {
        ${intersectPlane}
        vec2 point = planePoint.xz / gridStep;
        float minor = lines(point);
        float major = lines(point / 10.0);
        float fade = 1.0 - smoothstep(gridFade * 0.35, gridFade, distance(planePoint.xz, gridCenter));
        float horizon = smoothstep(0.01, 0.12, abs(planeRay.y));
        float footprint = max(fwidth(point).x, fwidth(point).y);
        float alpha = max(minor * 0.09 * (1.0 - smoothstep(0.5, 1.5, footprint)), major * 0.14) * fade * horizon;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(gridColor, alpha);
        #include <colorspace_fragment>
      }`
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'Viewport grid';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.raycast = () => {};
  mesh.onBeforeRender = (renderer, scene, camera) => {
    updateCamera(values, camera, mesh.userData.height || 0);
    values.gridColor.value = mesh.userData.overRender ? renderColor : color;
    const radius = mesh.userData.radius || 1;
    values.gridStep.value = 10 ** Math.floor(Math.log10(radius / 4));
    values.gridFade.value = Math.max(radius * 16, Math.abs(values.planeEye.value.y - values.planeHeight.value) * 8);
    values.gridCenter.value.set(mesh.userData.center?.x || 0, mesh.userData.center?.z || 0);
  };
  return mesh;
}
