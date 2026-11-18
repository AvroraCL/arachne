import {Scene,PerspectiveCamera,WebGLRenderer,HemisphereLight,DirectionalLight,Box3,Vector3} from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {profileScene} from './profile-model.mjs';

export function profilePreview(canvas,parts){
  const renderer=new WebGLRenderer({canvas,alpha:true,antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  const camera=new PerspectiveCamera(36,1,.01,100);
  const scene=new Scene();
  scene.add(new HemisphereLight(0xffffff,0x67747c,1.6));
  const key=new DirectionalLight(0xfff1e0,2.1);
  key.position.set(-2,5,3);scene.add(key);
  const fill=new DirectionalLight(0xd1e5ff,1.5);
  fill.position.set(3,1,-4);scene.add(fill);
  const controls=new OrbitControls(camera,canvas);
  let model,jump=true;
  function draw(){
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if(!w||!h)return;
    const ratio=renderer.getPixelRatio();
    if(canvas.width!==Math.floor(w*ratio)||canvas.height!==Math.floor(h*ratio)){
      renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
    }
    renderer.render(scene,camera);
  }
  function release(){
    if(!model)return;
    scene.remove(model);
    for(const mesh of model.children){mesh.geometry.dispose();mesh.material.dispose();}
  }
  function update(index,isolated,fit){
    const next=profileScene(parts);
    release();model=next;scene.add(model);
    for(const [i,mesh] of model.children.entries())mesh.visible=!isolated||index===i;
    if(jump||fit){
      const target=isolated?model.children[index]:model;
      const box=new Box3().setFromObject(target),size=box.getSize(new Vector3()),center=box.getCenter(new Vector3());
      const direction=jump?new Vector3(.75,.95,1):camera.position.clone().sub(controls.target);
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(direction.normalize(),Math.max(.05,size.length()*1.45));
      controls.update();jump=false;
    }
    draw();
  }
  controls.addEventListener('change',draw);
  const observer=new ResizeObserver(draw);observer.observe(canvas);
  return {update,dispose(){
    observer.disconnect();controls.dispose();release();renderer.dispose();renderer.forceContextLoss();
  }};
}
