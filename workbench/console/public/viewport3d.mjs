import {channelSpecs,activePaintChannels,renderChannel} from './paint-channels.mjs';
import {applyModelState} from './paint-model-state.mjs';
import {configureNavigation,attachOrbitInput,alignedCamera,projectionCamera,movedCamera} from './viewport-navigation.mjs';
import {createUnlitMaterial,updateLivePaintTextures,fillLivePaintTextures} from './viewport-materials.mjs';
import {createViewportEnvironment} from './viewport-environment.mjs';
import {sceneOptions} from './scene-options.mjs';
import {depthRangeForBounds} from './viewport-depth.mjs';
import {createObjectOutline} from './viewport-selection.mjs';
import {createAxisGizmo} from './viewport-gizmo.mjs';
import {createViewportPathTracer} from './viewport-path-tracer.mjs';
import {watchViewportScale} from './viewport-display-scale.mjs';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

// This module displays registered UV color only; it never pretends the 2D board is already baked.
export function createViewport({host,onStatus=()=>{},onMaterials=()=>{},onSelect=()=>{},onRenderPreviewStatus=()=>{},onModelingPick,animateAxes=false,localUI=false}){
  let resizeObserver,stopWatchingScale,pixelRatio=1;let disposed=false,sceneCursor=null,cursorMark=null;
  let renderer,scene,camera,controls,model,previewModel,manifest,doc,sequence=0,active=false,pending=false,sceneChanged=true;
  let scalarTextures={},texture,maskPreview=null,textureOverride=null,textureSequence=0,wireframe=false,unlit=false,orthographic=false,solo=false,selected=null;
  let livePaint=null,paintFrame=null,axisMotion=null,liveUsageKey='';
  let inspectionMap=null,inspectionChannel='';
  let radius=1,center=new THREE.Vector3(),topUp=new THREE.Vector3(0,0,-1),frameCount=0;
 const modelBounds=new THREE.Box3(),depthForward=new THREE.Vector3();
 let objectOutline=null,showOverlays=true,outlineCount=0,displayMode=null,xray=false;
 const solidMaterial=new THREE.MeshStandardMaterial({color:0x9a9a9a,roughness:.74});
 const wireMaterial=new THREE.MeshBasicMaterial({color:0xababab,wireframe:true});
 const displayArrays=new WeakMap();
 function setOutlineStatus(){
   const count=showOverlays?outlineCount:0;
   host.dataset.objectSelectionStyle=count?'silhouette':'none';host.dataset.outlinedObjects=String(count);
 }
 function syncEnvironment(){environment?.set({...displaySettings,grid:showOverlays&&displaySettings.grid});}
 function setOverlays(value){
   if(showOverlays===value)return;
   showOverlays=value;setOutlineStatus();syncEnvironment();request();
 }
 function renderScene(){
   const material=!unlit&&(displayMode==='solid'?solidMaterial:displayMode==='wire'?wireMaterial:null);
   if(!material){renderer.render(scene,camera);return;}
   const saved=[];
   (previewModel||model)?.traverseVisible(object=>{
     if(!object.isMesh)return;
     const original=object.material;
     saved.push([object,original]);
     if(Array.isArray(original)){
       let slots=displayArrays.get(original);
       if(!slots){slots={solid:original.map(()=>solidMaterial),wire:original.map(()=>wireMaterial)};displayArrays.set(original,slots);}
       object.material=slots[displayMode];
     }else object.material=material;
   });
   try{renderer.render(scene,camera);}finally{for(const [object,original] of saved)object.material=original;}
 }
 function drawOutline(){if(showOverlays)objectOutline?.render(camera);}

 let environment=null,displaySettings=sceneOptions(),cameraSignature='',pathTracer=null;
 function notifyCamera(){const data=camera.matrixWorld.elements.concat(camera.projectionMatrix.elements).map(n=>n.toPrecision(12)).join(',');if(data!==cameraSignature){cameraSignature=data;host.dataset.projection=camera.isOrthographicCamera?'orthographic':'perspective';host.dispatchEvent(new CustomEvent('viewport-camera'));}}

  const materialState=new WeakMap();
  const materials=new Map(),loader=new GLTFLoader(),gizmoState={instance:null};
  const state=(text,kind='info')=>onStatus(text,kind);
  function drawAxis(){const root=host.querySelector('.vp-axis');if(!root||!camera)return;gizmoState.instance??=createAxisGizmo({root,getCamera:()=>camera,frameAxis,isMoving:()=>!!axisMotion});gizmoState.instance.draw();}
  function updateViewLabel(){
    if(!camera||!controls)return;
    let label=host.querySelector('.studio-view-label');
    if(!label){
      label=document.createElement('div');
      label.className='studio-view-label';host.append(label);
    }
    let view='user',text='用户';
    if(!axisMotion){
      const direction=camera.position.clone().sub(controls.target).normalize();
      if(direction.y>.9999){view='top';text='顶视';}
      else if(direction.y<-.9999){view='bottom';text='底视';}
      else if(direction.dot(topUp)>.9999){view='front';text='前视';}
      else if(direction.dot(topUp)<-.9999){view='back';text='后视';}
      else if(direction.x>.9999){view='side';text='右视';}
      else if(direction.x<-.9999){view='left';text='左视';}
    }
    host.dataset.cameraView=view;
    host.dataset.projection=camera.isOrthographicCamera?'orthographic':'perspective';
    label.textContent=text+' · '+(camera.isOrthographicCamera?'正交':'透视')+(selected?' · '+selected:'');
    (localUI?host:document).querySelectorAll('[data-camera]').forEach(button=>
      button.setAttribute('aria-pressed',String(button.dataset.camera===view)));
  }
  function clearRenderedPaint(){
    delete host.dataset.renderedPaintRevision;
    delete host.dataset.renderedPaintResolution;
    delete host.dataset.renderedPaintDraft;
  }
  function drawTracedGrid(){
    if(!showOverlays||!displaySettings.grid)return;
    const colorWrite=new Map();
    const background=scene.background,autoClear=renderer.autoClear;
    (previewModel||model)?.traverseVisible(object=>{
      if(!object.isMesh)return;
      for(const material of [object.material].flat())if(!colorWrite.has(material)){
        colorWrite.set(material,material.colorWrite);material.colorWrite=false;
      }
    });
    scene.background=null;renderer.autoClear=false;
    try{
      renderer.clearDepth();
      environment.drawRenderOverlays(()=>renderer.render(scene,camera));
    }finally{
      for(const [material,enabled] of colorWrite)material.colorWrite=enabled;
      scene.background=background;renderer.autoClear=autoClear;
    }
  }
  function renderObserved(scanScene=true){
    if(!pathTracer?.enabled()){renderScene();drawOutline();return;}
    const root=previewModel||model,hidden=[];
    const visibility=doc?.paint?.renderVisibility,defaults=manifest?.metadata?.render_visibility;
    if(visibility||defaults)root?.traverseVisible(object=>{
      const name=object.userData.modelingLabel||object.name;
      if((Object.hasOwn(visibility||{},name)?visibility[name]:defaults?.[name])===false){
        object.visible=false;hidden.push(object);
      }
    });
    try{
      const traced=pathTracer.render(root,camera,modelBounds,displaySettings,scene.children.filter(object=>object.isDirectionalLight),scanScene);
      if(!traced)renderScene();
      else if(pathTracer.state().phase==='paused')return;
      else drawTracedGrid();
      drawOutline();
    }finally{for(const object of hidden)object.visible=true;}
  }
  function setRenderPreview(options,retry){
    if(options.enabled&&renderer&&!pathTracer)
      pathTracer=createViewportPathTracer({renderer,host,request,accumulate:()=>scheduleFrame(false),onStatus:onRenderPreviewStatus});
    pathTracer?.setOptions(options,retry);
  }
  function request(){scheduleFrame(true);}
  function scheduleFrame(scanScene){
    sceneChanged||=scanScene;
    if(!renderer||pending||!active)return;
    pending=true;
    requestAnimationFrame(now=>{
      pending=false;
      if(!active||host.clientWidth<2||host.clientHeight<2)return;
      if(axisMotion)advanceAxisMotion(now);else controls.update();
      updateDepthRange();notifyCamera();
      const rescan=sceneChanged;sceneChanged=false;
      renderObserved(rescan);
      if(livePaint&&paintFrame){
        host.dataset.renderedPaintRevision=String(paintFrame.revision??'');
        host.dataset.renderedPaintResolution=String(paintFrame.size);
        host.dataset.renderedPaintDraft=String(paintFrame.draft);
      }else clearRenderedPaint();
      drawAxis();updateSceneCursor();updateViewLabel();
      renderer.domElement.dataset.frames=String(++frameCount);
      if(axisMotion)request();
    });
  }
  function size(){if(!renderer)return;const w=host.clientWidth,h=host.clientHeight;if(w<2||h<2)return;
    if(renderer.getPixelRatio()!==pixelRatio)renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w,h,false);
    host.dataset.pixelRatio=String(pixelRatio);
    const aspect=w/h;if(camera.isPerspectiveCamera)camera.aspect=aspect;else{const half=camera.userData.half||radius;camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;}
    camera.updateProjectionMatrix();request();
  }
  function bindControls(target=center){controls?.dispose();controls=new OrbitControls(camera,renderer.domElement);configureNavigation(controls);controls.dampingFactor=.08;controls.target.copy(target);controls.minDistance=radius*.05;controls.maxDistance=radius*40;controls.addEventListener('change',request);controls.addEventListener('start',()=>host.dispatchEvent(new CustomEvent('viewport-interaction',{detail:{active:true}})));controls.addEventListener('end',()=>host.dispatchEvent(new CustomEvent('viewport-interaction',{detail:{active:false}})));controls.update();}
  function init(){if(renderer)return;renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;renderer.domElement.tabIndex=0;renderer.domElement.setAttribute('aria-label','三维模型视口，中键旋转，Shift中键平移，滚轮缩放，F聚焦材质');host.append(renderer.domElement);scene=new THREE.Scene();objectOutline=createObjectOutline({renderer,scene});scene.add(new THREE.HemisphereLight(0xffffff,0x444444,2));for(const [pos,power] of [[[4,6,3],2.8],[[-3,2,-4],1.2]]){const light=new THREE.DirectionalLight(0xffffff,power);light.position.set(...pos);scene.add(light);}environment=createViewportEnvironment({renderer,scene,host,bounds:modelBounds,request});syncEnvironment();camera=new THREE.PerspectiveCamera(38,1,.001,100000);camera.position.set(2,1.5,2);bindControls();resizeObserver=new ResizeObserver(size);resizeObserver.observe(host);stopWatchingScale=watchViewportScale(window,next=>{pixelRatio=next;size();});attachOrbitInput(renderer.domElement,()=>controls);let down;renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY,e.altKey?-1:e.button];});renderer.domElement.addEventListener('pointerup',e=>{if(!model||!down||down[2]!==0||Math.hypot(e.clientX-down[0],e.clientY-down[1])>4)return;if(!onModelingPick?.(e))selectMaterialAt(e);});renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();state('三维上下文丢失，请刷新视口','error');});size();}
  function selectMaterialAt(event) {
    const hit = pickModel(event, model);
    const material = hit && (Array.isArray(hit.object.material)
      ? hit.object.material[hit.face.materialIndex] : hit.object.material);
    select(material ? material.userData.sourceMaterial || material.name : null);
    onSelect(selected);
  }
  function pickModel(event, root) {
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    return ray.intersectObject(root, true)[0];
  }
  function updateModelBounds() {
    if (!model) return;
    modelBounds.setFromObject(previewModel || model);
    request();
  }
  function showModelingPreview(preview) {
    previewModel?.removeFromParent();
    previewModel = preview;
    model.visible = !preview;
    if (preview) scene.add(preview);
    else applyModelState(model,doc.modeling);
    updateModelBounds();
  }
  function sourceMaterialForExport(material) {
    const copy = material.clone();
    const original = materialState.get(material);
    if (!original) return copy;
    copy.map = original.map;
    copy.color.copy(original.color);
    copy.opacity = original.opacity;
    copy.transparent = original.transparent;
    copy.depthWrite = original.depthWrite;
    if ('metalness' in copy) {
      copy.metalness = original.metalness;
      copy.roughness = original.roughness;
      copy.metalnessMap = original.metalnessMap;
      copy.roughnessMap = original.roughnessMap;
    }
    copy.wireframe = false;
    return copy;
  }
  function modelingContext() {
    if (host.dataset.state !== 'ready') return null;
    applyModelState(model,null);
    return {
      modelSha256:manifest.modelSha256,model, scene, canvas: renderer.domElement, binding: manifest.key,
      setObjectOutline:(objects,helpers,activeObject)=>{objectOutline.setObjects(objects,helpers,activeObject);outlineCount=objects.length;setOutlineStatus();request();},
      getCamera: () => camera, request, updateModelBounds, showModelingPreview, sourceMaterialForExport,
      frameBounds: bounds => fit(camera.position.clone().sub(controls.target),bounds,camera.up.clone()),
      readCamera: () => ({camera:cameraState(),frameMode:host.dataset.frameMode}),
      restoreCamera: state => {
        applyCamera(state.camera);
        if (state.frameMode) host.dataset.frameMode = state.frameMode;
        else delete host.dataset.frameMode;
      },
      setNavigation: enabled => { controls.enabled = enabled; }
    };
  }
  function updateDepthRange(){if(!model||modelBounds.isEmpty())return;camera.updateMatrixWorld();camera.getWorldDirection(depthForward);const range=depthRangeForBounds(modelBounds,camera.position,depthForward,camera.isOrthographicCamera);if(range&&(camera.near!==range.near||camera.far!==range.far)){camera.near=range.near;camera.far=range.far;camera.updateProjectionMatrix();}}
  function disposeModel() {
    if (!model) return;
    objectOutline?.clear();outlineCount=0;setOutlineStatus();
    releaseLivePaint();
    clearChannelPreview();
    previewModel?.removeFromParent();
    previewModel = null;
    scene.remove(model);
    const allMaterials = new Set(), textures = new Set();
    model.traverse(object => {
      object.geometry?.dispose();
      for (const material of [...(object.userData.viewportOriginalMaterials || []), ...(object.userData.viewportUnlitMaterials || [])]) {
        allMaterials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        for(const image of Object.values(materialState.get(material)||{}))if(image?.isTexture)textures.add(image);
      }
    });
    for (const material of allMaterials) material.dispose();
    if (texture) textures.add(texture);
    for (const image of textures) image.dispose();
    model = null;
    modelBounds.makeEmpty();
    materials.clear();
    texture = null;for(const value of Object.values(scalarTextures))value.dispose();scalarTextures={};
  }
  function paintMaterials() {
    const enabled=new Set(livePaint?activePaintChannels(doc.paint):manifest?.activeChannels||activePaintChannels(doc?.paint));
    const liveMap=key=>livePaint?.[key==='ao'?'scalar':key==='height'||key==='alpha'?'detail':key];
    for (const [name, list] of materials) {
      for (const material of list) {
        const original = materialState.get(material);
        const isTarget = name === manifest.targetMaterial;
        const dimmed = Boolean(solo && selected && name !== selected);
        material.wireframe = wireframe;
        const inspecting=isTarget&&!!inspectionChannel;
        material.map = isTarget ? maskPreview||inspectionMap||livePaint?.color||texture||original.map : original.map;
        material.color.copy(isTarget && (maskPreview||livePaint||texture) ? new THREE.Color(0xffffff) : original.color);
        const extra=k=>isTarget&&enabled.has(k)?(liveMap(k)||scalarTextures[k]):null;
        const alpha=extra('alpha');
        if('metalness' in material){
          const metallic=isTarget?(livePaint?.scalar||scalarTextures.metallic):null;
          const roughness=isTarget?(livePaint?.scalar||scalarTextures.roughness):null;
          material.metalnessMap=metallic||original.metalnessMap;
          material.roughnessMap=roughness||original.roughnessMap;
          material.metalness=metallic?1:original.metalness;
          material.roughness=roughness?1:original.roughness;
          const normal=extra('normal'),height=extra('height'),emission=extra('emission'),ao=extra('ao');
          material.normalMap=normal||original.normalMap;material.bumpMap=height||original.bumpMap;material.bumpScale=height?.05:original.bumpScale;
          if(normal)material.normalScale.set(1,1);
          else material.normalScale.copy(original.normalScale);
          material.emissiveMap=emission||original.emissiveMap;material.emissive.copy(emission?new THREE.Color(1,1,1):original.emissive);material.emissiveIntensity=emission?1:original.emissiveIntensity;
          material.aoMap=ao||original.aoMap;material.aoMapIntensity=ao?1:original.aoMapIntensity;
        }
        material.alphaMap = inspecting?null:alpha||original.alphaMap;
        material.opacity = (inspecting||alpha?1:original.opacity) * (dimmed ? .12 : 1);
        const paintedBlend=Boolean(alpha&&!material.alphaTest);
        material.transparent = dimmed||!inspecting&&(original.transparent||paintedBlend);
        material.depthWrite = !dimmed&&(inspecting||!paintedBlend&&original.depthWrite);
        material.needsUpdate = true;
      }
    }
    request();
  }
  function textureStatus(){if(!manifest)return;if(['image_generation','pbr_paint'].includes(doc?.workflowType)){host.dataset.textureKind=manifest.textureRevision===null?'original':'baked';host.dataset.textureRevision=String(manifest.textureRevision);state(manifest.textureLabel,'ready');return;}host.dataset.textureKind=manifest.textureRevision===null?'original':'baked';host.dataset.textureRevision=String(manifest.textureRevision);const current=manifest.textureRevision===doc?.revision;state(manifest.textureLabel+(current?' · 与当前版本一致':' · 画板修改尚未烘焙到此贴图'),current?'ready':'notice');}
  function resolvedTexture(next){return textureOverride?{...next,...textureOverride}:next;}
  async function applyTexture(next,token,textureToken=++textureSequence){
    const slots=[...(next.textureUrl?[['color',next.textureUrl]]:[]),...Object.entries(next.materialUrls||{})];
    const results=await Promise.allSettled(slots.map(async([name,url])=>[name,await new THREE.TextureLoader().loadAsync(url)]));
    const loaded=Object.fromEntries(results.filter(r=>r.status==='fulfilled').map(r=>r.value));
    if(results.some(r=>r.status==='rejected')||token!==sequence||textureToken!==textureSequence){for(const v of Object.values(loaded))v.dispose();const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;return;}
    for(const [name,v] of Object.entries(loaded)){v.flipY=false;v.colorSpace=channelSpecs[name]?.srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;v.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}
    texture?.dispose();for(const v of Object.values(scalarTextures))v.dispose();texture=loaded.color;delete loaded.color;scalarTextures=loaded;manifest=next;paintMaterials();textureStatus();
  }
  async function loadProject(nextDoc){
    const changed=doc?.id!==nextDoc.id;const previousCamera=!changed&&model&&camera?(axisMotion?.end||cameraState()):null;axisMotion=null;doc=nextDoc;manifest=null;if(changed)textureOverride=null;textureSequence++;delete host.dataset.meshes;delete host.dataset.uvUnchanged;const token=++sequence;host.dataset.projectId=nextDoc.id;host.dataset.state='loading';state('正在准备真实模型…');
    try{init();disposeModel();onMaterials([]);let r=await fetch(`/api/projects/${doc.id}/viewport`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});let next=await r.json();if(!r.ok)throw Error(next.error||'模型请求失败');
      while(next.status==='running'){await new Promise(resolve=>setTimeout(resolve,650));if(token!==sequence)return;const r=await fetch(`/api/projects/${nextDoc.id}/viewport`);next=await r.json();if(!r.ok)throw Error(next.error||'模型准备状态读取失败');}
      if(token!==sequence)return;if(next.status!=='ready')throw Error(next.error||'模型尚未准备好');
      state('正在载入模型与原 UV 贴图…');const gltf=await loader.loadAsync(next.modelUrl);if(token!==sequence){gltf.scene.traverse(o=>o.geometry?.dispose());return;}manifest=next;model=gltf.scene;scene.add(model);
      model.traverse(object => {
        if (onModelingPick) {
          const mapping = gltf.parser.associations.get(object);
          if (object.isMesh && mapping?.meshes !== undefined) {
            object.userData.modelingPrimitive = mapping.meshes+':'+(mapping.primitives??0);
          }
          if (mapping?.nodes !== undefined && mapping.meshes !== undefined) {
            object.userData.modelingObject = mapping.nodes;
            object.userData.modelingLabel = gltf.parser.json.nodes[mapping.nodes]?.name;
          }
        }
        if (!object.isMesh) return;
        const original = Array.isArray(object.material) ? object.material : [object.material];
        object.userData.viewportOriginalMaterials = original;
        object.userData.viewportUnlitMaterials = original.map(createUnlitMaterial);
        for (const material of [...original, ...object.userData.viewportUnlitMaterials]) {
          const name = material.userData.sourceMaterial || material.name;
          material.userData.sourceMaterial = name;
          if (!materials.has(name)) materials.set(name, new Set());
          materials.get(name).add(material);
          materialState.set(material, {normalMap:material.normalMap,normalScale:material.normalScale?.clone(),bumpMap:material.bumpMap,bumpScale:material.bumpScale,emissiveMap:material.emissiveMap,emissive:material.emissive?.clone(),emissiveIntensity:material.emissiveIntensity,alphaMap:material.alphaMap,aoMap:material.aoMap,aoMapIntensity:material.aoMapIntensity,metalnessMap:material.metalnessMap,roughnessMap:material.roughnessMap,metalness:material.metalness,roughness:material.roughness,map: material.map, color: material.color.clone(), opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite});
          for (const image of Object.values(material)) if (image?.isTexture) image.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        }
      });
      if(doc.modeling?.steps?.length&&doc.modeling.modelSha256!==next.modelSha256)throw Error('工程建模绑定与当前模型不一致，无法重放');
      applyModelState(model,doc.modeling);
      const box=modelBounds.setFromObject(model);box.getCenter(center);radius=Math.max(box.getSize(new THREE.Vector3()).length()*.5,.001);topUp.fromArray(next.topUp);host.dataset.meshes=String(next.metadata.mesh_count);host.dataset.uvUnchanged=String(next.metadata.uv_unchanged);selected=null;environment.sync();model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
      onMaterials(next.metadata.materials);if(unlit)shade(true);await applyTexture(resolvedTexture(next),token);if(token!==sequence)return;if(previousCamera)applyCamera(previousCamera);else fit();host.dataset.state='ready';
    }catch(e){if(token!==sequence)return;host.dataset.state='error';state('三维视口：'+e.message,'error');}
  }
  function fit(direction=new THREE.Vector3(1,.75,1),bounds=null,upVector=new THREE.Vector3(0,1,0)){
    if(!camera||!model)return;
    const box=bounds||new THREE.Box3().setFromObject(previewModel||model);
    if(box.isEmpty())return;
    axisMotion=null;
    camera.up.copy(upVector);
    direction.normalize();
    const aspect=Math.max(.01,host.clientWidth/Math.max(host.clientHeight,1));
    const tangent=Math.tan(THREE.MathUtils.degToRad((camera.fov||38)/2));
    const right=new THREE.Vector3().crossVectors(camera.up,direction).normalize();
    const up=new THREE.Vector3().crossVectors(direction,right).normalize();
    const corner=new THREE.Vector3(),margin=1.12;
    box.getCenter(center);
    host.dataset.frameMode=bounds?'selection':'all';
    let distance=0,half=0;
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
      corner.set(x,y,z).sub(center);
      const extent=Math.max(Math.abs(corner.dot(right))/aspect,Math.abs(corner.dot(up)))*margin;
      distance=Math.max(distance,corner.dot(direction)+extent/tangent);
      half=Math.max(half,extent);
    }
    camera.position.copy(center).addScaledVector(direction,Math.max(distance,.001));
    camera.zoom=1;
    camera.userData.half=Math.max(half,.001);
    bindControls();
    size();
    request();
  }
  function frameAll(){if(camera&&model)fit(camera.position.clone().sub(controls.target),null,camera.up.clone());}
  function focusSelected(){if(!model||!selected)return frameAll();const box=new THREE.Box3();let found=false;model.traverse(o=>{if(o.isMesh&&(Array.isArray(o.material)?o.material:[o.material]).some(m=>m.userData.sourceMaterial===selected)){box.expandByObject(o);found=true;}});if(found)fit(camera.position.clone().sub(controls.target),box,camera.up.clone());else frameAll();}
  function direction(view){
    if(!model)return;
    const up=topUp.toArray(),opposite=topUp.clone().negate().toArray(),vertical=[0,1,0];
    const map={top:[[0,1,0],up],bottom:[[0,-1,0],opposite],front:[up,vertical],back:[opposite,vertical],
      side:[[1,0,0],vertical],right:[[1,0,0],vertical],left:[[-1,0,0],vertical],oblique:[[1,.75,1],vertical]};
    const [vector,basis]=map[view]||map.oblique;
    alignViewport(vector,basis,view!=='oblique');
  }
  function frameAxis(axis,sign){
    if(!model)return;
    alignViewport(new THREE.Vector3().setComponent(axis,sign).toArray(),
      axis===1?topUp.clone().multiplyScalar(sign).toArray():[0,1,0],true);
  }
  function alignViewport(direction,up,ortho){
    const end=alignedCamera(cameraState(),direction,up,ortho);
    if(!animateAxes||!active||document.documentElement.dataset.motion==='reduced'||
       document.documentElement.dataset.motion!=='full'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      applyCamera(end);return;
    }
    const pivot=new THREE.Vector3().fromArray(end.target),eye=new THREE.Vector3().fromArray(end.eye);
    const from=camera.quaternion.clone();
    const to=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(
      eye,pivot,new THREE.Vector3().fromArray(end.up)));
    if(from.angleTo(to)<.00001){applyCamera(end);return;}
    axisMotion={end,pivot,from,to,distance:camera.position.distanceTo(pivot),start:performance.now()};
    request();
  }
  function advanceAxisMotion(now){
    const {end,pivot,from,to,distance,start}=axisMotion;
    const t=Math.max(0,(now-start)/180);
    if(t>=1){applyCamera(end);return;}
    camera.quaternion.copy(from).slerp(to,t*t*(3-2*t));
    camera.position.set(0,0,distance).applyQuaternion(camera.quaternion).add(pivot);
    camera.up.set(0,1,0).applyQuaternion(camera.quaternion);
    camera.updateMatrixWorld();
  }
  if(animateAxes){
    const interrupt=event=>{
      if(axisMotion&&event.target===renderer?.domElement)applyCamera(cameraState());
    };
    host.addEventListener('pointerdown',interrupt,true);
    host.addEventListener('wheel',interrupt,{capture:true,passive:true});
  }
  function projection(value){if(!renderer||orthographic===value)return;applyCamera(projectionCamera(cameraState(),value));}
  function navigate(command,amount=1){if(!model)return;applyCamera(movedCamera(cameraState(),command,amount,host.clientHeight));}

  function select(name){selected=name;paintMaterials();}
  const uvRay=new THREE.Raycaster(),uvPointer=new THREE.Vector2();
  function pickTargetUV(clientX,clientY){
    if(!model||!manifest||host.dataset.state!=='ready')return null;
    const rect=renderer.domElement.getBoundingClientRect();
    if(!rect.width||!rect.height)return null;
    uvPointer.set((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2);
    uvRay.setFromCamera(uvPointer,camera);
    const hit=uvRay.intersectObject(model,true)[0];
    if(!hit?.uv||!hit.face)return null;
    const material=Array.isArray(hit.object.material)?hit.object.material[hit.face.materialIndex]:hit.object.material;
    if((material.userData.sourceMaterial||material.name)!==manifest.targetMaterial)return null;
    const uv=hit.object.geometry.getAttribute('uv');
    if(!uv)return null;
    const normal=hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
    return {u:hit.uv.x,v:hit.uv.y,triangle:[hit.face.a,hit.face.b,hit.face.c].map(i=>[uv.getX(i),uv.getY(i)]),
      point:fromView(hit.point),normal:fromView(normal)};
  }
  function focusDistanceAt(clientX,clientY,renderVisibility={}){
    if(!model||!renderer||!camera||host.dataset.state!=='ready')return null;
    const rect=renderer.domElement.getBoundingClientRect(),root=previewModel||model;
    if(!rect.width||!rect.height)return null;
    uvPointer.set((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2);
    camera.updateMatrixWorld();root.updateMatrixWorld(true);uvRay.setFromCamera(uvPointer,camera);
    for(const hit of uvRay.intersectObject(root,true)){
      let visible=true;
      for(let object=hit.object;object;object=object.parent){
        if(!object.visible){visible=false;break;}
        const original=object.userData.original||object,name=original.userData.modelingLabel||original.name;
        if(Object.hasOwn(renderVisibility,name)&&renderVisibility[name]===false){visible=false;break;}
        if(object===root)break;
      }
      if(!visible)continue;
      const depth=-camera.worldToLocal(hit.point.clone()).z;
      if(depth>0)return depth;
    }
    return null;
  }
  // Blender world coordinates are authoritative for the registered UV cache.
  const fromView=({x,y,z})=>[x,-z,y];
  function viewFrame(){
    const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0);
    const up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);
    const normal=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,2);
    return {right:fromView(right),up:fromView(up),normal:fromView(normal),radius};
  }
  function screenPoint([x,y,z]){
    if(!camera||!model)return null;
    const point=new THREE.Vector3(x,z,-y).project(camera);
    if(Math.abs(point.x)>1||Math.abs(point.y)>1||Math.abs(point.z)>1)return null;
    return [(point.x+1)*host.clientWidth/2,(1-point.y)*host.clientHeight/2];
  }
  function setSceneCursor(position){
    if(JSON.stringify(sceneCursor)===JSON.stringify(position))return;
    sceneCursor=position;
    if(position&&!cursorMark){
      cursorMark=document.createElement('span');
      cursorMark.className='viewport-scene-cursor';cursorMark.setAttribute('aria-hidden','true');cursorMark.hidden=true;
      cursorMark.innerHTML='<svg viewBox="0 0 22 22"><path d="M11 0v22M0 11h22" stroke="#181818" stroke-width="2"/><path d="M11 0v22M0 11h22" stroke="#f5f5f5"/><circle cx="11" cy="11" r="6" fill="none" stroke="#fafafa" stroke-width="2"/><circle cx="11" cy="11" r="6" fill="none" stroke="#db5757" stroke-width="2" stroke-dasharray="4 4"/></svg>';
      host.append(cursorMark);
    }
    updateSceneCursor();request();
  }
  function updateSceneCursor(){
    if(!cursorMark)return;
    const screen=showOverlays&&sceneCursor&&screenPoint(sceneCursor);
    cursorMark.hidden=!screen;
    if(screen)cursorMark.style.transform=`translate(${screen[0]}px,${screen[1]}px) translate(-50%,-50%)`;
  }
  function cursorPointAt(clientX,clientY){
    if(!model||host.dataset.state!=='ready')return null;
    const rect=renderer.domElement.getBoundingClientRect(),root=previewModel||model;
    if(!rect.width||!rect.height)return null;
    uvPointer.set((clientX-rect.left)/rect.width*2-1,1-(clientY-rect.top)/rect.height*2);
    root.updateMatrixWorld(true);camera.updateMatrixWorld();
    uvRay.setFromCamera(uvPointer,camera);
    for(const hit of uvRay.intersectObject(root,true)){
      let object=hit.object;
      while(object&&object!==root&&object.visible)object=object.parent;
      if(object===root&&root.visible)return fromView(hit.point);
    }
    const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()),controls.target);
    const point=uvRay.ray.intersectPlane(plane,new THREE.Vector3());
    return point?fromView(point):null;
  }
  function releaseLivePaint(){
    if(!livePaint)return false;
    for(const map of new Set(Object.values(livePaint)))map.dispose();
    livePaint=null;paintFrame=null;liveUsageKey='';
    clearRenderedPaint();
    return true;
  }
  function showLivePaint(pixels,size,solo,metadata={}){
    if(!pixels){
      if(releaseLivePaint()&&model)paintMaterials();
      return;
    }
    if(!model)return;
    const create=colorSpace=>{
      const map=new THREE.DataTexture(new Uint8Array(size*size*4),size,size,THREE.RGBAFormat);
      map.colorSpace=colorSpace;
      map.magFilter=THREE.LinearFilter;
      map.minFilter=THREE.LinearMipmapLinearFilter;
      map.generateMipmaps=true;
      map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      return map;
    };
    const channels=activePaintChannels(doc.paint);
    const {maps,changed}=updateLivePaintTextures(livePaint,size,channels,create);
    livePaint=maps;
    fillLivePaintTextures(pixels,size,livePaint,solo);
    paintFrame={revision:metadata.revision,size,draft:metadata.draft===true};
    for(const map of Object.values(livePaint))map.needsUpdate=true;
    const usage=JSON.stringify(channels);
    if(changed||usage!==liveUsageKey){liveUsageKey=usage;paintMaterials();}else request();
  }
  function showMaskCanvas(canvas){
    if(!canvas){maskPreview?.dispose();maskPreview=null;if(model)paintMaterials();return;}
    if(!maskPreview||maskPreview.image!==canvas){
      maskPreview?.dispose();maskPreview=new THREE.CanvasTexture(canvas);
      maskPreview.flipY=false;maskPreview.colorSpace=THREE.SRGBColorSpace;
      if(model)paintMaterials();
    }
    maskPreview.needsUpdate=true;request();
  }
  function clearChannelPreview(){
    inspectionMap?.dispose();inspectionMap=null;inspectionChannel='';
  }
  function showChannelPreview(frame,channel){
    if(!model)return false;
    if(!frame||!Object.hasOwn(channelSpecs,channel)){
      if(inspectionChannel){clearChannelPreview();paintMaterials();}
      return false;
    }
    const {pixels,request:{size}}=frame;
    if(channel==='color')clearChannelPreview();
    else{
      if(inspectionMap?.image.width!==size){
        inspectionMap?.dispose();
        inspectionMap=new THREE.DataTexture(new Uint8Array(size*size*4),size,size,THREE.RGBAFormat);
        inspectionMap.colorSpace=THREE.SRGBColorSpace;
        inspectionMap.magFilter=THREE.LinearFilter;inspectionMap.minFilter=THREE.LinearFilter;
      }
      renderChannel(pixels,size,channel,inspectionMap.image.data);
      inspectionMap.needsUpdate=true;
    }
    inspectionChannel=channel;
    paintMaterials();return true;
  }
  function shade(flat) {
    unlit = flat;
    if (!model) return;
    model.traverse(object => {
      if (!object.isMesh) return;
      const list = flat ? object.userData.viewportUnlitMaterials : object.userData.viewportOriginalMaterials;
      object.material = list.length === 1 ? list[0] : list;
    });
    previewModel?.traverse(object=>{if(object.isMesh&&object.userData.original?.isMesh)object.material=object.userData.original.material;});
    paintMaterials();
  }
  function setDisplay(mode,nextXray,inspectMask){
    if(displayMode!==mode||xray!==nextXray){
      displayMode=mode;xray=nextXray;host.toggleAttribute('data-xray',xray);
      for(const material of [solidMaterial,wireMaterial]){
        material.opacity=xray ? .22 : 1;material.transparent=xray;material.depthWrite=!xray;
        material.needsUpdate=true;
      }
    }
    if(unlit!==inspectMask)shade(inspectMask);
    request();
  }
  function cameraState() {
    return {projection:camera.isOrthographicCamera?'orthographic':'perspective',eye:camera.position.toArray(),target:controls.target.toArray(),up:camera.up.toArray(),fov:camera.isPerspectiveCamera?camera.getEffectiveFOV():38,orthoHeight:camera.isOrthographicCamera?(camera.top-camera.bottom)/camera.zoom:camera.position.distanceTo(controls.target)*2*Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()/2))};
  }
  function applyCamera(data) {
    if (!renderer || !data) return;
    const values = [...data.eye, ...data.target, ...data.up, data.fov, data.orthoHeight];
    if (!values.every(Number.isFinite)) throw Error('Invalid viewport camera');
    axisMotion=null;
    orthographic = data.projection === 'orthographic';
    camera = orthographic ? new THREE.OrthographicCamera(-1, 1, 1, -1, .001, radius * 200) : new THREE.PerspectiveCamera(data.fov, 1, .001, radius * 200);
    camera.position.fromArray(data.eye);
    camera.up.fromArray(data.up);
    camera.userData.half = data.orthoHeight / 2;
    bindControls(new THREE.Vector3(...data.target));
    (localUI?host.querySelector('[data-vp-ortho]'):document.getElementById('vp-ortho'))?.setAttribute('aria-pressed', String(orthographic));
    size();
  }
  return {showChannelPreview,readCamera:()=>camera&&cameraState(),dispose(){if(disposed)return;disposed=true;sequence++;textureSequence++;active=false;resizeObserver?.disconnect();stopWatchingScale?.();controls?.dispose();pathTracer?.dispose();disposeModel();objectOutline?.dispose();environment?.dispose();solidMaterial.dispose();wireMaterial.dispose();renderer?.dispose();renderer?.domElement.remove();cursorMark?.remove();},modelingContext,applyCamera,navigate,pickTargetUV,focusDistanceAt,viewFrame,screenPoint,setSceneCursor,cursorPointAt,showLivePaint,showMaskCanvas,setRenderPreview,renderPreviewState:()=>pathTracer?.state(),setDisplay,setOverlays,setEnvironment(raw){displaySettings=sceneOptions(raw);syncEnvironment();},capture(){if(!renderer||!camera||host.dataset.state!=='ready')throw Error('请等待模型载入');updateDepthRange();renderObserved();notifyCamera();const data=renderer.domElement.toDataURL('image/png');request();return data;},getRenderSettings(samples=64){if(!manifest||host.dataset.state!=='ready'||!camera)throw Error('请等待三维模型与贴图载入');const aspect=host.clientWidth/Math.max(host.clientHeight,1),width=Math.round(Math.min(1200,1200*aspect)),height=Math.round(width/aspect);const match=manifest.textureUrl?.match(/\/jobs\/([^/]+)\/files\//);return {samples,width:Math.max(128,width),height:Math.max(128,Math.min(2048,height)),textureJobId:match?.[1]||null,camera:cameraState()};},loadProject,focusSelected,setActive(value){active=value;if(!active&&axisMotion)applyCamera(axisMotion.end);else size();},fit:frameAll,direction,projection,select,setWireframe(value){wireframe=value;paintMaterials();},setUnlit:shade,setSolo(value){solo=value;paintMaterials();},syncDocument(next){if(doc?.id!==next.id)return loadProject(next);const changed=JSON.stringify(doc.modeling)!==JSON.stringify(next.modeling),visibilityChanged=JSON.stringify(doc.paint?.renderVisibility)!==JSON.stringify(next.paint?.renderVisibility);doc=next;if(visibilityChanged)request();if(changed&&model&&!previewModel){applyModelState(model,doc.modeling);updateModelBounds();request();}textureStatus();},async setTextureSource(source){textureOverride=source;await this.refreshTexture();},async reload(){if(doc)return loadProject(doc);},async refreshTexture(){if(!doc||!manifest||host.dataset.state==='error')return;const token=sequence,textureToken=++textureSequence;try{const r=await fetch(`/api/projects/${doc.id}/viewport`);if(!r.ok)throw Error('贴图来源请求失败');const next=resolvedTexture(await r.json());if(token!==sequence||textureToken!==textureSequence)return;if(next.status==='ready'&&(next.textureUrl!==manifest.textureUrl||JSON.stringify(next.materialUrls)!==JSON.stringify(manifest.materialUrls)))await applyTexture(next,token,textureToken);else{manifest=next;textureStatus();}}catch(e){state('贴图更新失败：'+e.message,'error');}},getState(){return {projectId:doc?.id,modelRadius:radius,meshCount:host.dataset.meshes,frames:frameCount,clipping:camera?{near:camera.near,far:camera.far}:null,selected,wireframe,unlit,orthographic,position:camera?.position.toArray(),materialUrls:manifest?.materialUrls,textureUrl:manifest?.textureUrl,textureRevision:manifest?.textureRevision};}};
}
