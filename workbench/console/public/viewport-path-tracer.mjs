import * as THREE from 'three';
import {createPathTracingEngine} from './path-tracing-engine.mjs';
import {projectTone,projectLightRig,projectEnvironment} from './path-trace-lighting.mjs';
import {renderLightingDefaults} from './render-lighting.mjs';

const off={phase:'off',text:'',retry:false};

export function createViewportPathTracer({renderer,host,request,onStatus}){
  let options={enabled:false},status=off,engine=null,loading=false,failed=false,disposed=false;
  let scene=null,library=null,environment=null,environmentKey='',ground=null,lights=[],meshSignature='',materialSignature='',lightingSignature='',cameraSignature='',renderTone=null;

  function publish(phase,text='',samples=0){
    if(status.phase===phase&&status.text===text)return;
    status={phase,text,retry:phase==='error'};
    if(phase==='off'){
      delete host.dataset.renderPhase;
      delete host.dataset.renderBackend;
      delete host.dataset.renderSamples;
    }else{
      host.dataset.renderBackend='path-tracer';
      host.dataset.renderPhase=phase;
      host.dataset.renderSamples=String(samples);
    }
    onStatus(status);
  }

  function release(){
    engine?.dispose();
    environment?.dispose();
    ground?.geometry.dispose();
    ground?.material.dispose();
    engine=scene=library=environment=ground=renderTone=null;
    lights=[];
    meshSignature=materialSignature=lightingSignature=cameraSignature=environmentKey='';
  }

  function fail(error){
    release();
    failed=true;
    publish('error','路径追踪不可用 · '+error.message);
  }

  function prepare(){
    if(loading||failed)return;
    loading=true;
    publish('loading','路径追踪 · 正在准备');
    void createPathTracingEngine(renderer).then(({engine:prepared,library:backend})=>{
      if(disposed||!options.enabled){prepared.dispose();return;}
      engine=prepared;
      library=backend;
      engine.tiles.set(2,2);
      scene=new THREE.Scene();
      ground=new THREE.Mesh(new THREE.PlaneGeometry(1,1),
        new THREE.MeshStandardMaterial({side:THREE.DoubleSide}));
      ground.rotation.x=-Math.PI/2;
    }).catch(error=>{if(!disposed&&options.enabled)fail(error);}).finally(()=>{
      loading=false;
      if(!disposed&&options.enabled)request();
    });
  }

  function setupLighting(settings,bounds,sourceLights,imported,project){
    const center=bounds.getCenter(new THREE.Vector3());
    const radius=Math.max(bounds.getSize(new THREE.Vector3()).length()/2,.001);
    const lighting=project?.lighting||renderLightingDefaults;
    const key=project?'project:'+lighting.environmentColor:'viewport';
    if(key!==environmentKey){
      environment?.dispose();
      environmentKey=key;
      environment=project?projectEnvironment(library,lighting):new library.GradientEquirectTexture(64);
      if(!project){
        environment.topColor.set('#acb6c8');environment.bottomColor.set('#4a4a4a');environment.update();
      }
      scene.environment=environment;
    }
    for(const light of lights)light.removeFromParent();
    if(project){
      scene.environmentIntensity=lighting.environmentStrength;
      scene.background=project.transparent?null:new THREE.Color(lighting.environmentColor);
      lights=projectLightRig(lighting,center,radius);
      for(const source of imported){
        const light=source.clone(false);
        light.matrixAutoUpdate=false;
        light.matrix.copy(source.matrixWorld);
        if(source.target){
          source.target.getWorldPosition(light.target.position);
          light.target.updateMatrixWorld(true);
        }
        lights.push(light);
      }
    }else{
      scene.environmentIntensity=settings.environmentStrength;
      scene.background=settings.background==='solid'?new THREE.Color(settings.backgroundColor):null;
      lights=sourceLights.map(source=>{
        const light=new THREE.RectAreaLight(source.color,source.intensity*.65,radius*1.3,radius*.9);
        light.position.copy(source.position);
        light.lookAt(center);
        return light;
      });
    }
    for(const light of lights)scene.add(light);
    ground.material.color.set(settings.groundColor);
    ground.material.roughness=settings.groundRoughness;
    ground.position.set(center.x,bounds.min.y+settings.groundHeight*radius-radius*.003,center.z);
    ground.scale.set(radius*80,radius*80,1);
  }

  function syncScene(root,camera,bounds,settings,sourceLights){
    const meshes=[],imported=[],project=options.project;
    const showGround=!project&&settings.ground;
    root.updateWorldMatrix(true,true);
    root.traverseVisible(object=>{
      if(object.isMesh)meshes.push(object);
      else if(project&&(object.isDirectionalLight||object.isSpotLight||object.isPointLight||object.isRectAreaLight))imported.push(object);
    });
    if(!meshes.length&&!showGround)return false;
    const nextMesh=JSON.stringify([showGround?[settings.groundColor,settings.groundHeight,settings.groundRoughness,bounds.min,bounds.max]:null,meshes.map(mesh=>[
      mesh.id,mesh.geometry.id,mesh.geometry.attributes.position.version,mesh.matrixWorld.elements,
      [mesh.material].flat().map(material=>material.id)
    ])]);
    const materials=[...new Set(meshes.flatMap(mesh=>mesh.material))];
    const nextMaterial=JSON.stringify(materials.map(material=>[
      material.id,material.version,Object.values(material).filter(value=>value?.isTexture)
        .map(texture=>[texture.id,texture.version])
    ]));
    const nextLighting=JSON.stringify([bounds.min,bounds.max,project?[project.lighting,project.transparent,
      imported.map(light=>[light.id,light.matrixWorld.elements,light.intensity,light.color])]:
      [settings.environmentStrength,settings.background,settings.backgroundColor,sourceLights.map(light=>[light.position,light.intensity])]]);
    const lightingChanged=nextLighting!==lightingSignature;
    if(lightingChanged||nextMesh!==meshSignature&&showGround){
      setupLighting(settings,bounds,sourceLights,imported,project);
      lightingSignature=nextLighting;
    }
    const nextCamera=JSON.stringify([camera.id,camera.matrixWorld.elements,camera.projectionMatrix.elements]);
    if(nextMesh!==meshSignature){
      for(const child of [...scene.children])if(child.isMesh)child.removeFromParent();
      for(const mesh of meshes){
        const surface=new THREE.Mesh(mesh.geometry,mesh.material);
        surface.matrixAutoUpdate=false;
        surface.matrix.copy(mesh.matrixWorld);
        scene.add(surface);
      }
      if(showGround)scene.add(ground);
      engine.setScene(scene,camera);
      meshSignature=nextMesh;
    }else{
      if(lightingChanged){
        scene.updateMatrixWorld(true);
        engine.updateEnvironment();
        engine.updateLights();
      }
      if(nextMaterial!==materialSignature)engine.updateMaterials();
      if(nextCamera!==cameraSignature)engine.setCamera(camera);
    }
    materialSignature=nextMaterial;
    cameraSignature=nextCamera;
    return true;
  }

  function present(){
    if(!renderTone){engine.renderSample();return;}
    const {toneMapping,toneMappingExposure}=renderer;
    Object.assign(renderer,renderTone);
    try{engine.renderSample();}
    finally{Object.assign(renderer,{toneMapping,toneMappingExposure});}
  }

  return {
    setOptions(next,retry=false){
      const previous=options;
      options=next;
      if(!next.enabled){
        if(previous.enabled){release();failed=false;publish('off');request();}
        return;
      }
      if(retry){release();failed=false;}
      if(retry||previous.enabled!==next.enabled||previous.paused!==next.paused||
         previous.interacting!==next.interacting||previous.suspended!==next.suspended||
         previous.samples!==next.samples||JSON.stringify(previous.project)!==JSON.stringify(next.project))request();
    },
    render(root,camera,bounds,settings,sourceLights){
      if(!options.enabled||!root||failed)return false;
      if(options.paused&&!options.suspended){
        const samples=Math.floor(engine?.samples||0);
        publish('paused','路径追踪 · 已暂停',samples);
        if(samples<1)return false;
        try{engine.pausePathTracing=true;present();return true;}
        catch(error){fail(error);return false;}
      }
      if(options.suspended||options.interacting){
        publish('waiting',options.suspended?'路径追踪 · 编辑中':'路径追踪 · 等待视角稳定');
        return false;
      }
      if(!engine){prepare();return false;}
      try{
        const size=renderer.getDrawingBufferSize(new THREE.Vector2());
        engine.renderScale=Math.min(settings.resolution,960/Math.max(size.x,size.y));
        engine.bounces=settings.bounces;
        if(!syncScene(root,camera,bounds,settings,sourceLights)){
          publish('waiting','路径追踪 · 没有可见物体');
          return false;
        }
        const target=options.samples??settings.samples;
        renderTone=options.project?projectTone(options.project.appearance||undefined):null;
        engine.pausePathTracing=engine.samples>=target;
        present();
        const samples=Math.floor(engine.samples);
        publish(samples>=target?'ready':'sampling',`路径追踪 · ${samples} / ${target} 采样`,samples);
        if(engine.samples<target)request();
        return samples>=1;
      }catch(error){fail(error);return false;}
    },
    state:()=>status,
    enabled:()=>options.enabled,
    dispose(){disposed=true;release();}
  };
}
