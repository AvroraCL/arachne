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

export function createStudioGround(){
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshStandardMaterial({side:THREE.DoubleSide}));
  ground.rotation.x=-Math.PI/2;
  return ground;
}

export function studioGroundVisible(lighting,transparent){
  return lighting?.ground?.enabled===true&&!transparent;
}

export function placeStudioGround(ground,bounds,color,roughness=.78,height=-.0002){
  const center=bounds.getCenter(new THREE.Vector3());
  const radius=Math.max(.001,bounds.getSize(new THREE.Vector3()).length()/2);
  ground.material.color.set(color);
  ground.material.roughness=roughness;
  ground.position.set(center.x,bounds.min.y+radius*height,center.z);
  ground.scale.set(radius*80,radius*80,1);
}

export function projectEnvironment(library,settings){
  const color=(settings||renderLightingDefaults).environmentColor;
  const environment=new library.GradientEquirectTexture(64);
  environment.topColor.set(color);
  environment.bottomColor.copy(environment.topColor).multiplyScalar(.45);
  environment.update();
  return environment;
}
