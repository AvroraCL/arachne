import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {applyModelState} from './paint-model-state.mjs';
import {channelSpecs} from './paint-channels.mjs';
import {createPathTracingEngine} from './path-tracing-engine.mjs';
import {renderLightingDefaults} from './render-lighting.mjs';
import {renderAppearanceDefaults} from './render-appearance.mjs';
import {projectTone,projectLightRig,projectEnvironment} from './path-trace-lighting.mjs';

async function loadModel(input){
  const gltf=await new GLTFLoader().loadAsync('/input/model.glb');
  const root=gltf.scene,materials=new Set();
  root.traverse(node=>{
    const binding=gltf.parser.associations.get(node);
    if(binding?.nodes!==undefined){
      const name=gltf.parser.json.nodes[binding.nodes]?.name;
      if(binding.meshes!==undefined)node.userData.modelingObject=binding.nodes;
      if((Object.hasOwn(input.visibility,name)?input.visibility[name]:input.defaultVisibility[name])===false)node.visible=false;
    }
    if(node.isMesh)for(const material of [node.material].flat())
      if((material.userData.sourceMaterial||material.name)===input.material)materials.add(material);
  });
  if(!materials.size)throw Error('登记 GLB 中找不到工程涂装材质');
  if(input.modeling?.steps?.length)applyModelState(root,input.modeling);
  const loader=new THREE.TextureLoader();
  const maps=Object.fromEntries(await Promise.all(input.channels.map(async channel=>{
    const texture=await loader.loadAsync('/input/'+channel+'.png');
    texture.flipY=false;
    texture.colorSpace=channelSpecs[channel].srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;
    return [channel,texture];
  })));
  for(const material of materials){
    if(maps.color){material.map=maps.color;material.color.set(0xffffff);}
    if(maps.metallic){material.metalnessMap=maps.metallic;material.metalness=1;}
    if(maps.roughness){material.roughnessMap=maps.roughness;material.roughness=1;}
    if(maps.normal){material.normalMap=maps.normal;material.normalScale.set(1,1);}
    if(maps.emission){
      material.emissiveMap=maps.emission;material.emissive.set(0xffffff);material.emissiveIntensity=1;
    }
    if(maps.alpha){material.alphaMap=maps.alpha;material.opacity=1;material.alphaTest=0;material.transparent=true;}
    material.needsUpdate=true;
  }
  return root;
}

function makeCamera(settings,center,radius,optics,PhysicalCamera){
  const {width,height}=settings,aspect=width/height;
  const distance=radius/Math.sin(THREE.MathUtils.degToRad(19*Math.min(1,aspect)))*1.12;
  const automatic={projection:'perspective',eye:center.clone().addScaledVector(
    new THREE.Vector3(1,.75,1).normalize(),distance).toArray(),target:center.toArray(),up:[0,1,0],fov:38};
  const view=settings.camera||automatic,eye=new THREE.Vector3(...view.eye);
  const far=Math.max(eye.distanceTo(center)+radius*4,1);
  const near=Math.max(.00001,far/1e7);
  const half=(view.orthoHeight||1)/2;
  const camera=view.projection==='orthographic'?
    new THREE.OrthographicCamera(-half*aspect,half*aspect,half,-half,near,far):
    new PhysicalCamera(view.fov,aspect,near,far);
  camera.position.copy(eye);
  camera.up.fromArray(view.up);
  camera.lookAt(...view.target);
  if(optics?.enabled&&camera.isPerspectiveCamera){
    camera.fStop=optics.fStop;
    camera.focusDistance=optics.focusMode==='target'?eye.distanceTo(new THREE.Vector3(...view.target)):optics.focusDistance;
    camera.apertureBlades=optics.blades;
    camera.apertureRotation=THREE.MathUtils.degToRad(optics.rotation);
    camera.anamorphicRatio=optics.ratio;
  }else if(camera.isPerspectiveCamera)camera.bokehSize=0;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return {camera,view};
}

function setupLighting(scene,library,lighting,center,radius,transparent){
  const {environmentColor,environmentStrength}=lighting||renderLightingDefaults;
  const environment=projectEnvironment(library,lighting);
  scene.environment=environment;
  scene.environmentIntensity=environmentStrength;
  if(!transparent)scene.background=new THREE.Color(environmentColor);
  for(const light of projectLightRig(lighting,center,radius))scene.add(light);
  return environment;
}

function outputCanvas(source,settings,region,appearance){
  const canvas=document.createElement('canvas');
  [canvas.width,canvas.height]=region?.output||[settings.width,settings.height];
  const context=canvas.getContext('2d',{alpha:settings.transparent===true,willReadFrequently:appearance.gamma!==1||appearance.look!=='None'});
  if(region){
    const [left,top,right,bottom]=region.pixels,w=right-left,h=bottom-top;
    context.drawImage(source,left,top,w,h,region.crop?0:left,region.crop?0:top,w,h);
  }else context.drawImage(source,0,0);
  if(appearance.gamma!==1||appearance.look!=='None'){
    const data=context.getImageData(0,0,canvas.width,canvas.height);
    const contrast=appearance.look.endsWith('High Contrast')?1.2:appearance.look.endsWith('Low Contrast')?.8:1;
    const table=Uint8ClampedArray.from({length:256},(_,i)=>255*(.5+(Math.pow(i/255,1/appearance.gamma)-.5)*contrast));
    for(let i=0;i<data.data.length;i+=4)for(let j=0;j<3;j++)data.data[i+j]=table[data.data[i+j]];
    context.putImageData(data,0,0);
  }
  return canvas;
}

function completedRenderTarget(engine){
  const target=engine.target,pair=engine._pathTracer?._blendTargets;
  // Version 0.0.24 exposes the first completed alpha buffer even on even passes.
  // Its accumulator alternates the two buffers after each complete sample.
  return pair?.[1]===target&&engine.samples%2===0?pair[0]:target;
}

async function downloadLinearExr(renderer,target,settings,region){
  const {EXRExporter}=await import('three/addons/exporters/EXRExporter.js');
  const [left,top,right,bottom]=region?.pixels||[0,0,target.width,target.height];
  const width=right-left,height=bottom-top;
  const [outputWidth,outputHeight]=region?.output||[width,height];
  // WebGL buffers start at the bottom. EXRExporter flips their rows on export.
  const pixels=new Float32Array(width*height*4);
  await renderer.readRenderTargetPixelsAsync(target,left,target.height-bottom,width,height,pixels);
  for(let i=0;i<pixels.length;i+=4){
    const alpha=settings.transparent?pixels[i+3]:1;
    // The path tracer stores straight RGB. OpenEXR compositing uses associated alpha.
    pixels[i]*=alpha;
    pixels[i+1]*=alpha;
    pixels[i+2]*=alpha;
    pixels[i+3]=alpha;
  }
  let output=pixels;
  if(region&&!region.crop){
    output=new Float32Array(outputWidth*outputHeight*4);
    if(!settings.transparent)for(let i=3;i<output.length;i+=4)output[i]=1;
    for(let row=0;row<height;row++){
      const start=row*width*4;
      output.set(pixels.subarray(start,start+width*4),((outputHeight-bottom+row)*outputWidth+left)*4);
    }
  }
  const texture=new THREE.DataTexture(output,outputWidth,outputHeight,THREE.RGBAFormat,THREE.FloatType);
  try{
    const bytes=await new EXRExporter().parse(texture,{compression:0,type:settings.bitDepth===32?THREE.FloatType:THREE.HalfFloatType});
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
    // The isolated browser stays open until the worker has collected the download.
    const anchor=document.createElement('a');
    anchor.href=url;
    anchor.download='render.exr';
    anchor.click();
  }finally{texture.dispose();}
}

export async function renderImage(input){
  const {settings,region}=input,appearance=input.appearance||renderAppearanceDefaults;
  const renderer=new THREE.WebGLRenderer({alpha:true,preserveDrawingBuffer:true,antialias:false});
  let engine,environment;
  try{
    const gl=renderer.getContext(),limit=gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    if(settings.width>limit||settings.height>limit)throw Error('当前图形设备不支持所选输出分辨率');
    renderer.setSize(settings.width,settings.height,false);
    Object.assign(renderer,projectTone(appearance));
    const backend=await createPathTracingEngine(renderer);
    engine=backend.engine;
    engine.tiles.set(4,4);
    engine.bounces=Math.max(1,settings.maxBounces);
    engine.transmissiveBounces=settings.maxBounces;
    engine.textureSize.set(2048,2048);
    const present=engine.renderToCanvasCallback;
    engine.renderToCanvasCallback=(target,output,quad)=>{
      if(engine.samples===settings.samples)quad.material.map=completedRenderTarget(engine).texture;
      present(target,output,quad);
    };
    const scene=new THREE.Scene(),root=await loadModel(input);
    scene.add(root);
    const bounds=new THREE.Box3().setFromObject(root),center=bounds.getCenter(new THREE.Vector3());
    const radius=Math.max(.001,bounds.getSize(new THREE.Vector3()).length()/2);
    const {camera,view}=makeCamera(settings,center,radius,input.optics,backend.library.PhysicalCamera);
    environment=setupLighting(scene,backend.library,input.lighting,center,radius,settings.transparent);
    engine.setScene(scene,camera);
    let sample=0;
    while(sample<settings.samples){
      engine.renderSample();
      const next=Math.floor(engine.samples);
      if(next>sample){sample=next;await globalThis.reportRenderSample(sample);}
      else await new Promise(resolve=>setTimeout(resolve,0));
      if(gl.isContextLost())throw Error('路径追踪过程中图形设备连接中断');
    }
    if(settings.fileFormat==='OPEN_EXR')await downloadLinearExr(renderer,completedRenderTarget(engine),settings,region);
    const canvas=outputCanvas(renderer.domElement,settings,region,appearance);
    return {png:canvas.toDataURL('image/png').split(',')[1],camera:view,samples:sample};
  }finally{
    engine?.dispose();environment?.dispose();renderer.dispose();renderer.forceContextLoss();
  }
}
