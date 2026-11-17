import * as THREE from 'three';
import {createPathTracingEngine} from './path-tracing-engine.mjs';
import {createStudioGround,placeStudioGround,studioGroundVisible,projectLightRig,projectEnvironment} from './path-trace-lighting.mjs';
import {renderAppearanceDefaults} from './render-appearance.mjs';
import {completedPathTraceTarget,drawPathTrace,setPathTraceDisplay} from './path-trace-display.mjs';
import {renderLightingDefaults} from './render-lighting.mjs';
import {applyProjectLens} from './path-trace-camera.mjs';
import {viewportConvergence} from './cycles-viewport-sampling.mjs';
import {createViewportAdaptiveSampler} from './viewport-adaptive-sampler.mjs';

const off={phase:'off',text:'',retry:false};

export function createViewportPathTracer({renderer,host,request,accumulate=request,onStatus}){
  let options={enabled:false},status=off,engine=null,loading=false,failed=false,disposed=false;
  let scene=null,sceneRoot=null,library=null,environment=null,environmentKey='',ground=null,lights=[],meshSignature='',materialSignature='',lightingSignature='',renderAppearance=null;
  let previousCamera=null,lensCamera=null,lensKey='',previousLensKey='',presented=null;
  let denoiseMaterial=null,denoiseStart=Infinity,adaptiveSampler=null;
  const cameraWorld=new THREE.Matrix4(),cameraProjection=new THREE.Matrix4(),drawingSize=new THREE.Vector2();

  function publish(phase,text='',samples=0){
    if(phase!=='off')host.dataset.renderSamples=String(samples);
    if(status.phase===phase&&status.text===text)return;
    status={phase,text,retry:phase==='error'};
    if(phase==='off'){
      delete host.dataset.renderPhase;
      delete host.dataset.renderBackend;
      delete host.dataset.renderSamples;
      delete host.dataset.renderResolution;
      delete host.dataset.renderDenoised;
      delete host.dataset.renderConverged;
    }else{
      host.dataset.renderBackend='path-tracer';
      host.dataset.renderPhase=phase;
    }
    onStatus(status);
  }

  function release(){
    adaptiveSampler?.dispose();
    engine?.dispose();
    denoiseMaterial?.dispose();
    environment?.dispose();
    ground?.geometry.dispose();
    ground?.material.dispose();
    engine=scene=sceneRoot=library=environment=ground=renderAppearance=previousCamera=lensCamera=null;
    presented=null;
    denoiseMaterial=null;
    adaptiveSampler=null;
    denoiseStart=Infinity;
    lights=[];
    meshSignature=materialSignature=lightingSignature=environmentKey=previousLensKey='';
  }

  function fail(error){
    release();
    failed=true;
    delete host.dataset.renderResolution;
    delete host.dataset.renderDenoised;
    delete host.dataset.renderConverged;
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
      // One untiled, quarter-size sample follows each new camera pose. Keep it
      // visible until every tile of the first full-resolution sample is ready.
      engine.dynamicLowRes=true;
      engine.lowResScale=.25;
      engine.rasterizeSceneCallback=()=>{}; // The viewport draws its own loading fallback.
      const drawRaw=engine.renderToCanvasCallback;
      engine.renderToCanvasCallback=(target,renderer,quad)=>{
        target=adaptiveSampler?.image()||completedPathTraceTarget(engine);
        quad.material.map=target.texture;
        if(engine.samples<denoiseStart){drawRaw(target,renderer,quad);return;}
        if(!denoiseMaterial){
          denoiseMaterial=new library.DenoiseMaterial({
            sigma:1.25,kSigma:1.6,threshold:.10,
            premultipliedAlpha:renderer.getContextAttributes().premultipliedAlpha
          });
          // The filter accumulates premultiplied colors. Tone-map straight RGB
          // before the shader applies the canvas's premultiplied alpha.
          denoiseMaterial.fragmentShader=denoiseMaterial.fragmentShader.replace(
            '#include <tonemapping_fragment>',
            'gl_FragColor.rgb /= max(gl_FragColor.a, 0.00001);\n#include <tonemapping_fragment>'
          );
        }
        const rawMaterial=quad.material;
        setPathTraceDisplay(denoiseMaterial,renderAppearance||renderAppearanceDefaults);
        denoiseMaterial.map=target.texture;
        quad.material=denoiseMaterial;
        try{drawRaw(target,renderer,quad);}
        finally{quad.material=rawMaterial;}
      };
      scene=new THREE.Scene();
      ground=createStudioGround();
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
    if(project){
      if(studioGroundVisible(lighting,project.transparent))placeStudioGround(ground,bounds,lighting.ground.color);
    }else placeStudioGround(ground,bounds,settings.groundColor,settings.groundRoughness,settings.groundHeight-.003);
  }

  function syncScene(root,camera,bounds,settings,sourceLights){
    const meshes=[],imported=[],project=options.project;
    const showGround=project?studioGroundVisible(project.lighting,project.transparent):settings.ground;
    root.updateWorldMatrix(true,true);
    root.traverseVisible(object=>{
      if(object.isMesh)meshes.push(object);
      else if(project&&(object.isDirectionalLight||object.isSpotLight||object.isPointLight||object.isRectAreaLight))imported.push(object);
    });
    if(!meshes.length&&!showGround)return false;
    const nextMesh=JSON.stringify([showGround?[project?project.lighting.ground:[settings.groundColor,settings.groundHeight,settings.groundRoughness],bounds.min,bounds.max]:null,meshes.map(mesh=>[
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
    const rebuild=nextMesh!==meshSignature;
    if(rebuild){
      for(const child of [...scene.children])if(child.isMesh)child.removeFromParent();
      for(const mesh of meshes){
        const surface=new THREE.Mesh(mesh.geometry,mesh.material);
        surface.matrixAutoUpdate=false;
        surface.matrix.copy(mesh.matrixWorld);
        scene.add(surface);
      }
      if(showGround)scene.add(ground);
      engine.setScene(scene,tracingCamera(camera));
      meshSignature=nextMesh;
    }else{
      if(lightingChanged){
        scene.updateMatrixWorld(true);
        engine.updateEnvironment();
        engine.updateLights();
      }
      if(nextMaterial!==materialSignature)engine.updateMaterials();
    }
    materialSignature=nextMaterial;
    syncCamera(camera,rebuild);
    return true;
  }

  function syncCamera(camera,rebuild=false){
    if(!rebuild&&camera===previousCamera&&lensKey===previousLensKey&&cameraWorld.equals(camera.matrixWorld)&&cameraProjection.equals(camera.projectionMatrix))return;
    previousCamera=camera;
    previousLensKey=lensKey;
    cameraWorld.copy(camera.matrixWorld);cameraProjection.copy(camera.projectionMatrix);
    if(!rebuild)engine.setCamera(tracingCamera(camera));
  }

  function tracingCamera(camera){
    const {optics,focusTarget}=options.project||{};
    const useLens=!!(optics?.enabled&&camera.isPerspectiveCamera);
    host.toggleAttribute('data-render-depth-of-field',useLens);
    if(!useLens)return camera;
    lensCamera??=new library.PhysicalCamera();
    lensCamera.copy(camera,false);
    applyProjectLens(lensCamera,optics,focusTarget);
    return lensCamera;
  }

  function present(){
    drawPathTrace(engine,renderer,renderAppearance);
  }

  return {
    setOptions(next,retry=false){
      const previous=options;
      options=next;
      lensKey=next.project?.optics?.enabled?JSON.stringify([next.project.optics,next.project.focusTarget]):'';
      if(!next.enabled){
        host.removeAttribute('data-render-depth-of-field');
        if(previous.enabled){release();failed=false;publish('off');request();}
        return;
      }
      if(retry){release();failed=false;}
      if(retry||previous.enabled!==next.enabled||previous.paused!==next.paused||previous.suspended!==next.suspended||
         JSON.stringify(previous.project)!==JSON.stringify(next.project))request();
      else if(previous.interacting!==next.interacting||
         JSON.stringify(previous.sampling)!==JSON.stringify(next.sampling))accumulate();
    },
    render(root,camera,bounds,settings,sourceLights,sceneChanged=true,animating=false){
      if(!options.enabled||!root||failed)return false;
      if(options.paused&&!options.suspended){
        publish('paused','路径追踪 · 已暂停',presented?.samples||0);
        if(!presented)return false;
        host.dataset.renderResolution=presented.resolution;
        // A window resize must not discard the frozen sample buffer.
        engine.synchronizeRenderSize=false;
        try{engine.pausePathTracing=true;present();return true;}
        catch(error){fail(error);return false;}
        finally{if(engine)engine.synchronizeRenderSize=true;}
      }
      if(options.suspended){
        delete host.dataset.renderDenoised;
        delete host.dataset.renderConverged;
        publish('waiting','路径追踪 · 编辑中');
        return false;
      }
      if(!engine){prepare();return false;}
      try{
        const size=renderer.getDrawingBufferSize(drawingSize);
        engine.renderScale=Math.min(settings.resolution,960/Math.max(size.x,size.y));
        engine.bounces=settings.bounces;
        if(sceneChanged||sceneRoot!==root){
          if(!syncScene(root,camera,bounds,settings,sourceLights)){
            sceneRoot=null;
            presented=null;
            delete host.dataset.renderResolution;
            delete host.dataset.renderDenoised;
            delete host.dataset.renderConverged;
            publish('waiting','路径追踪 · 没有可见物体');
            return false;
          }
          sceneRoot=root;
        }else syncCamera(camera);
        const {maxSamples=settings.samples,denoise=false,denoiseStart:start=8}=options.sampling||{};
        const target=maxSamples||Infinity;
        denoiseStart=denoise?start:Infinity;
        renderAppearance=options.project?(options.project.appearance||renderAppearanceDefaults):null;
        const moving=options.interacting||animating;
        const convergence=viewportConvergence(options.sampling||{});
        if(convergence&&!moving)adaptiveSampler??=createViewportAdaptiveSampler(engine,renderer);
        adaptiveSampler?.configure(convergence);
        engine.pausePathTracing=moving||engine.samples>=target||adaptiveSampler?.poll()===true;
        present();
        const samples=Math.floor(engine.samples);
        const draft=samples===0&&!engine.isCompiling;
        const scale=draft?engine.lowResScale:1;
        const resolution=`${Math.floor(engine.target.width*scale)} × ${Math.floor(engine.target.height*scale)}`;
        if(engine.isCompiling&&samples===0){
          presented=null;
          delete host.dataset.renderResolution;
          delete host.dataset.renderDenoised;
          delete host.dataset.renderConverged;
          publish('loading','路径追踪 · 正在编译着色器');
          accumulate();
          return false;
        }
        presented={samples,resolution};
        host.dataset.renderResolution=resolution;
        const denoised=samples>=denoiseStart;
        const converged=adaptiveSampler?.poll()===true;
        host.dataset.renderConverged=String(converged);
        host.dataset.renderDenoised=String(denoised);
        if(moving)publish('navigating',`路径追踪 · ${resolution} · ${draft?'快速预览':'移动视角'}`,samples);
        else{
          const progress=draft?'正在细化':`${samples}${maxSamples?' / '+maxSamples:''} 采样${converged?' · 已收敛':''}${denoised?' · 降噪':''}`;
          const complete=converged||samples>=target;
          publish(complete?'ready':'sampling',`路径追踪 · ${resolution} · ${progress}`,samples);
          if(!complete)accumulate();
        }
        return true;
      }catch(error){fail(error);return false;}
    },
    state:()=>status,
    enabled:()=>options.enabled,
    dispose(){disposed=true;release();}
  };
}
