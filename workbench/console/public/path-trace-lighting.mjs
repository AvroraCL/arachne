import * as THREE from 'three';
import {presetRenderLights,renderLightingDefaults} from './render-lighting.mjs';
import {renderAppearanceDefaults} from './render-appearance.mjs';

const toneMappings={
  AgX:THREE.AgXToneMapping,Standard:THREE.LinearToneMapping,'Khronos PBR Neutral':THREE.NeutralToneMapping,
  Filmic:THREE.ACESFilmicToneMapping,Raw:THREE.NoToneMapping
};

export function projectTone(appearance=renderAppearanceDefaults){
  return {toneMapping:toneMappings[appearance.viewTransform],toneMappingExposure:2**appearance.exposure};
}

export function projectLightRig(settings,center,radius){
  const lighting=settings||renderLightingDefaults;
  const lights=lighting.preset==='custom'?lighting.lights:presetRenderLights(lighting.preset);
  const angle=THREE.MathUtils.degToRad(lighting.rotation);
  return lights.filter(light=>light.enabled&&light.intensity>0&&lighting.lightStrength>0).map(spec=>{
    const light=new THREE.RectAreaLight(spec.color,spec.intensity*lighting.lightStrength,spec.width*radius,spec.height*radius);
    const [x,y,z]=spec.position;
    light.name=spec.name;
    light.position.set(x,z,-y).applyAxisAngle(THREE.Object3D.DEFAULT_UP,angle).multiplyScalar(radius).add(center);
    light.lookAt(center);
    return light;
  });
}

export function projectEnvironment(library,settings){
  const color=(settings||renderLightingDefaults).environmentColor;
  const environment=new library.GradientEquirectTexture(64);
  environment.topColor.set(color);
  environment.bottomColor.copy(environment.topColor).multiplyScalar(.45);
  environment.update();
  return environment;
}
