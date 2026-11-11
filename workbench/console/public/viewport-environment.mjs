import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {sceneOptions} from './scene-options.mjs';
import {createInfiniteGround, createInfiniteGrid} from './viewport-ground.mjs';

const PROFILES = {
  studio: {positions: [[1.2, 1.7, 1], [-1.1, .6, .5], [.4, 1, -1.4]], powers: [2.8, .8, 2]},
  soft: {positions: [[1, 2, 1], [-1, 1, .4], [.3, 1.2, -1.5]], powers: [2, 1.4, 1.2]},
  daylight: {positions: [[1, 2.8, .8], [-1, 1, 0], [0, 1.4, -1]], powers: [3.3, .5, 1]}
};

export function createViewportEnvironment({renderer, scene, host, bounds, request}) {
  let settings = sceneOptions();
  const lights = scene.children.filter(object => object.isDirectionalLight);
  const ambient = scene.children.find(object => object.isHemisphereLight);
  while (lights.length < 3) {
    const light = new THREE.DirectionalLight(0xffffff, 1);
    scene.add(light);
    lights.push(light);
  }

  const room = new RoomEnvironment();
  const generator = new THREE.PMREMGenerator(renderer);
  const reflections = generator.fromScene(room, .04);
  room.dispose();
  generator.dispose();
  scene.environment = reflections.texture;

  const floor = createInfiniteGround();
  const grid = createInfiniteGrid();
  scene.add(floor, grid);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  function sync() {
    const current = settings;
    renderer.toneMappingExposure = 2 ** current.exposure;
    scene.background = current.background === 'solid' ? new THREE.Color(current.backgroundColor) : null;
    host.style.background = current.background === 'gradient'
      ? `linear-gradient(${current.backgroundTop}, ${current.backgroundColor})`
      : current.background === 'transparent'
        ? 'repeating-conic-gradient(#323232 0% 25%, #252525 0% 50%) 0 0 / 20px 20px'
        : current.backgroundColor;
    scene.environmentIntensity = current.environmentStrength * 2;
    scene.environmentRotation.y = current.rotation * Math.PI / 180;
    if (ambient) ambient.intensity = current.environmentStrength * .25;
    renderer.shadowMap.enabled = current.ground;
    floor.visible = current.ground && !bounds.isEmpty();
    grid.visible = current.grid && !bounds.isEmpty();
    if (bounds.isEmpty()) { request(); return; }

    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1e-5);
    const angle = current.rotation * Math.PI / 180;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const profile = PROFILES[current.environment];
    lights.forEach((light, index) => {
      const position = profile.positions[index % 3];
      light.position.set(
        center.x + (position[0] * cosine + position[2] * sine) * radius,
        center.y + position[1] * radius,
        center.z + (-position[0] * sine + position[2] * cosine) * radius
      );
      light.intensity = profile.powers[index % 3] * current.lightStrength;
      light.target.position.copy(center);
      if (!light.target.parent) scene.add(light.target);
      light.castShadow = current.ground && index === 0;
      light.shadow.mapSize.set(2048, 2048);
      Object.assign(light.shadow.camera, {
        left: -radius * 1.5, right: radius * 1.5, top: radius * 1.5, bottom: -radius * 1.5,
        near: radius * .01, far: radius * 8
      });
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.normalBias = radius * .0003;
      light.shadow.bias = -.00002;
    });
    const height = bounds.min.y + current.groundHeight * radius - radius * .003;
    floor.userData.height = height;
    floor.material.color.set(current.groundColor);
    floor.material.roughness = current.groundRoughness;
    grid.userData.height = height + radius * .0001;
    grid.userData.radius = radius;
    grid.userData.center = center;
    request();
  }

  return {
    set(raw) { settings = sceneOptions(raw); sync(); },
    sync,
    get: () => settings,
    drawRenderOverlays(action) {
      const floorVisible=floor.visible,shadows=renderer.shadowMap.enabled;
      floor.visible=false;grid.userData.overRender=true;renderer.shadowMap.enabled=false;
      try{return action();}
      finally{floor.visible=floorVisible;grid.userData.overRender=false;renderer.shadowMap.enabled=shadows;}
    },
    dispose() {
      for (const object of [floor, grid]) {
        scene.remove(object);
        object.geometry.dispose();
        object.material.dispose();
      }
      if (scene.environment === reflections.texture) scene.environment = null;
      reflections.dispose();
    }
  };
}
