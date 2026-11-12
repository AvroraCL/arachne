import {MathUtils,Vector3} from 'three';

export function applyProjectLens(camera,optics,target){
  if(!camera.isPerspectiveCamera)return;
  if(!optics?.enabled){camera.bokehSize=0;return;}
  camera.fStop=optics.fStop;
  camera.focusDistance=optics.focusMode==='target'?camera.position.distanceTo(new Vector3(...target)):optics.focusDistance;
  camera.apertureBlades=optics.blades;
  camera.apertureRotation=MathUtils.degToRad(optics.rotation);
  camera.anamorphicRatio=optics.ratio;
}
