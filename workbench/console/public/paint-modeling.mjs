import * as THREE from 'three';
import {objectClickSelection} from './paint-object-selection.mjs';
import {modelOrientation,numericModelDelta,createModelTransform,constraintSegment,worldAxes,modelPivotPoint,modelPivotLabels} from './paint-model-transform.mjs';
export {modelOrientation,numericModelDelta} from './paint-model-transform.mjs';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {axisColors} from './viewport-colors.mjs';
import {createObjectOrigins,objectOriginCenter} from './viewport-origins.mjs';
import {loadModelTopology,primitiveTopology,mergePrimitiveAliases,connectedVertexGroups} from './paint-model-topology.mjs';
import {modelStepForSource,writeVertexPositions} from './model-edit-steps.mjs';
import {smoothSelectedVertices} from './mesh-smoothing.mjs';
import {projectMarqueeVertices,vertexInMarquee,edgeInMarquee,faceCenterInMarquee,meshInMarquee,visitTriangles}
  from './paint-model-marquee.mjs';

const elementNames = {vertex:'点',edge:'边',face:'面'};
const identity = new THREE.Matrix4();

function segmentDistance(point, a, b) {
  const direction = b.clone().sub(a);
  const fraction = direction.lengthSq()
    ? THREE.MathUtils.clamp(point.clone().sub(a).dot(direction)/direction.lengthSq(), 0, 1) : 0;
  return a.clone().addScaledVector(direction,fraction).distanceTo(point);
}

export function createPaintModeling(report, project = {}) {
  let context, root, decorations, gizmo, pivot, origins, overlaysGroup, gizmoGroup, active = false;
  let showOverlays=true,showGizmo=true;
  let currentProject, storageKey, storageSnapshot, undo = [], redo = [], gesture = null, saving = false, error = '';
  let pendingOperation=null,queuedHistory=[];
  let mode = 'object', element = 'vertex', tool = 'translate', orientation = 'global', pivotMode = 'median', object = null;
  const selected = new Map(), selectedObjects = new Set(), objects = new Map(), meshes = [];
  const welds = new WeakMap();
  const point = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  let helper, marker, sceneItems = [];
  let topologyState = 'idle', topologyMeta = null, topologyRequest = null, selectionVersion=0;
  let localObjects = null, localCamera = null;
  let primitiveCache = new WeakMap(), objectAliases = new WeakMap();
  let connectedObject=null,connectedGroup=null;

  function notify() {
    const objectLabel = selectedObjects.size>1 ? '已选 '+selectedObjects.size+' 个物体' : object?.name;
    const materialNames = new Set();
    object?.traverse(node=>{if(node.isMesh)for(const material of [node.material].flat())materialNames.add(material?.userData.sourceMaterial||material?.name);});
    let uses=0;context?.model?.traverse(node=>{if(node.isMesh&&[node.material].flat().some(m=>(m.userData.sourceMaterial||m.name)==='f_16xl'))uses++;});
    const materialScope = materialNames.size&&!materialNames.has('f_16xl')?'所选物体使用原生材质 · 当前编辑示例材质':`示例材质 · ${uses} 个网格共用${objectLabel?' · '+objectLabel:''}`;
    const modal=gesture?.keyboard?.describe();
    report({materialScope,mode,element,tool,orientation,pivotMode,modal,dragging:!!gesture||saving||!!pendingOperation,hasDraft:!!undo.length,sceneItems,binding:context?.binding,projectId:currentProject,selectionVersion,
      activeId:object?.userData.modelingId,selectedIds:[...selectedObjects].map(node=>node.userData.modelingId),elementCount:selected.size,
      hasTransformTarget:!!object&&(mode==='object'||selected.size>0),topologyState,localActive:!!localObjects,
      selectionKey:mode==='edit'?[...selected.keys()].join(','):[...selectedObjects].map(node=>node.id).join(',')+'|active:'+object?.id,
      visibility:new Map([...objects].map(([id,node])=>[id,!inLocalView(node)?'outside':
        node.visible?(isVisible(node)?'visible':'inherited'):'hidden'])),
      hasHidden:!!localObjects||[...objects.values()].some(node=>node.visible!==node.userData.originalVisibility),
      summary:error || modal?.error || modal?.label || (saving?'正在保存建模修改…'+(queuedHistory.length?' · 历史操作已排队':''):mode==='edit'&&topologyState==='loading'?'正在读取原拓扑…':object
        ? (mode === 'object' ? objectLabel : object.name+' · 已选 '+selected.size+' '+elementNames[element])
        : '点击模型选择物体')});
  }

  function resetOverlay(node) {
    if (!node) return;
    node.removeFromParent();
    if (!node.userData.mesh || node.userData.edgeIndices) node.geometry.dispose();
    node.material.dispose();
  }

  function welded(mesh) {
    if (welds.has(mesh)) return welds.get(mesh);
    const original = mesh.userData.original.geometry.attributes.position;
    const groups = new Map(), representatives = [], members = new Map();
    for (let i=0;i<original.count;i++) {
      const key = point.fromBufferAttribute(original,i).toArray().join(',');
      if (!groups.has(key)) groups.set(key,i);
      const representative = groups.get(key);
      representatives.push(representative);
      if (!members.has(representative)) members.set(representative,[]);
      members.get(representative).push(i);
    }
    const result = {representatives,members};
    welds.set(mesh,result);
    return result;
  }

  function ownerOf(mesh) {
    let node = mesh;
    while (node && node.userData.modelingId===undefined) node = node.parent;
    return node;
  }

  function meshTopology(mesh) {
    if (!topologyMeta) return null;
    if (!primitiveCache.has(mesh)) {
      const key = mesh.userData.original.userData.modelingPrimitive;
      primitiveCache.set(mesh,primitiveTopology(mesh.geometry,topologyMeta[key]));
    }
    return primitiveCache.get(mesh);
  }

  function sourceAliases(owner) {
    if (objectAliases.has(owner)) return objectAliases.get(owner);
    const primitives = [];
    owner.traverse(mesh=>{
      if (!mesh.isMesh || ownerOf(mesh)!==owner) return;
      const topology = meshTopology(mesh);
      if (topology) primitives.push({mesh,topology});
    });
    const aliases = mergePrimitiveAliases(primitives);
    objectAliases.set(owner,aliases);
    return aliases;
  }

  function vertexKey(mesh,index) {
    const id = meshTopology(mesh)?.vertices[index];
    return id>=0 ? 'o'+ownerOf(mesh).id+':'+id : 'm'+mesh.id+':'+welded(mesh).representatives[index];
  }

  function aliasesForVertex(mesh,index) {
    const id = meshTopology(mesh)?.vertices[index];
    const native = id>=0 && sourceAliases(ownerOf(mesh)).get(id);
    if (native) return native;
    const {members,representatives} = welded(mesh);
    return [{mesh,indices:members.get(representatives[index])}];
  }

  async function prepareTopology(projectId) {
    if (topologyState!=='idle') return;
    const request = new AbortController();
    topologyRequest = request;
    topologyState = 'loading';
    updateSelection();
    try {
      const result = await loadModelTopology(projectId,request.signal);
      if (request.signal.aborted) return;
      topologyMeta = result.primitives;
      connectedObject=null;connectedGroup=null;
      topologyState = result.matchedPrimitives===result.expectedPrimitives?'ready':'partial';
    } catch {
      if (request.signal.aborted) return;
      topologyState = 'fallback';
    }
    if (topologyRequest===request) {
      topologyRequest = null;
      if (mode==='edit') {
        selected.clear();
        updateSelection();
      } else notify();
    }
  }

  function makeSelectionOverlay() {
    resetOverlay(marker);
    marker = null;
    if (!object || mode === 'object' || !selected.size) return;
    const positions = [];
    for (const {mesh,indices} of selected.values()) {
      for (const i of indices) {
        point.fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(mesh.matrixWorld);
        positions.push(...point.toArray());
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    const orange = 0xffa34f;
    if (element === 'vertex') {
      marker = new THREE.Points(geometry,new THREE.PointsMaterial({color:orange,size:7,sizeAttenuation:false,depthTest:false}));
    } else if (element === 'edge') {
      marker = new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:orange,depthTest:false}));
    } else {
      marker = new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({
        color:orange,side:THREE.DoubleSide,transparent:true,opacity:.55,depthWrite:false,
        polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-2
      }));
    }
    marker.renderOrder = 5;
    overlaysGroup.add(marker);
  }

  function updateHelpers() {
    origins?.update();
    if (!helper) return;
    for (const overlay of helper.children) {
      const {mesh,edgeIndices} = overlay.userData;
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.matrixWorldNeedsUpdate = true;
      if (edgeIndices) {
        const positions = overlay.geometry.attributes.position;
        const source = mesh.geometry.attributes.position;
        for (let i=0;i<edgeIndices.length;i++) {
          point.fromBufferAttribute(source,edgeIndices[i]);
          positions.setXYZ(i,point.x,point.y,point.z);
        }
        positions.needsUpdate = true;
      }
    }
  }

  function clearHelpers() {
    resetOverlay(marker);
    marker = null;
    if (!helper) return;
    helper.removeFromParent();
    for (const overlay of [...helper.children]) resetOverlay(overlay);
    helper = null;
  }

  function makeHelpers() {
    clearHelpers();
    origins.setObjects(mode==='object'?[...selectedObjects]:object?[object]:[],object);
    context.setObjectOutline?.(mode==='object'?[...selectedObjects]:[],decorations,mode==='object'?object:null);
    if (!object || mode==='object') return;
    helper = new THREE.Group();
    object.traverseVisible(mesh => {
      if (!mesh.isMesh) return;
      const edgeIndices = meshTopology(mesh)?.edgeIndices;
      let overlay;
      if (edgeIndices?.length) {
        const shape = new THREE.BufferGeometry();
        shape.setAttribute('position',new THREE.Float32BufferAttribute(edgeIndices.length*3,3));
        overlay = new THREE.LineSegments(shape,new THREE.LineBasicMaterial({
          color:0x252525,transparent:true,opacity:.5,depthWrite:false
        }));
        overlay.frustumCulled = false;
        overlay.userData.edgeIndices = edgeIndices;
      } else {
        overlay = new THREE.Mesh(mesh.geometry,new THREE.MeshBasicMaterial({
          color:0x252525,wireframe:true,transparent:true,opacity:.5,depthWrite:false,
          polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1
        }));
      }
      overlay.userData.mesh = mesh;
      overlay.matrixAutoUpdate = false;
      helper.add(overlay);
      if (element === 'vertex') {
        const points = new THREE.Points(mesh.geometry,new THREE.PointsMaterial({
          color:0x232323,size:3,sizeAttenuation:false,depthWrite:false
        }));
        points.userData.mesh = mesh;
        points.matrixAutoUpdate = false;
        helper.add(points);
      }
    });
    overlaysGroup.add(helper);
    updateHelpers();
  }

  function selectionTargets() {
    if (mode === 'object') {
      const roots = [...selectedObjects].filter(node=>{
        // A selected child already moves with its selected parent.
        for (let parent=node.parent;parent;parent=parent.parent) {
          if (selectedObjects.has(parent)) return false;
        }
        return true;
      });
      return roots.map(node=>({id:node.userData.modelingId}));
    }
    const byMesh = new Map();
    for (const {mesh,indices} of selected.values()) {
      for (const i of indices) {
        for (const alias of aliasesForVertex(mesh,i)) {
          if (!byMesh.has(alias.mesh)) byMesh.set(alias.mesh,new Set());
          const target = byMesh.get(alias.mesh);
          for (const vertex of alias.indices) target.add(vertex);
        }
      }
    }
    return [...byMesh].map(([mesh,indices])=>({mesh:mesh.userData.modelingMesh,vertices:[...indices]}));
  }

  function selectionCenter(kind=pivotMode) {
    if(kind==='cursor')return new THREE.Vector3(...(project.read?.()?.paint.sceneCursor||[0,0,0])).applyQuaternion(worldAxes);
    if (mode === 'object') {
      if(kind==='active'&&object)return object.getWorldPosition(new THREE.Vector3());
      if(kind==='bounds')return modelPivotPoint([...selectedObjects].map(node=>node.getWorldPosition(new THREE.Vector3())),kind);
      return objectOriginCenter(selectedObjects);
    }
    const entries=kind==='active'?[...selected.values()].slice(-1):selected.values();
    return modelPivotPoint(selectedPositions(entries),kind);
  }

  function* selectedPositions(entries){
    const unique=new Set();
    for(const {mesh,indices} of entries)for(const index of indices){
      const key=vertexKey(mesh,index);
      if(unique.has(key))continue;
      unique.add(key);
      yield point.fromBufferAttribute(mesh.geometry.attributes.position,index).applyMatrix4(mesh.matrixWorld);
    }
  }

  function updateSelection() {
    if (!active) return;
    root.updateMatrixWorld(true);
    makeHelpers();
    makeSelectionOverlay();
    gizmo.detach();
    if (object && (mode === 'object' || selected.size)) {
      pivot.position.copy(selectionCenter());
      pivot.quaternion.copy(modelOrientation(object,orientation));
      pivot.scale.setScalar(1);
      pivot.updateMatrixWorld(true);
      gizmo.attach(pivot);
    }
    context.request();
    notify();
  }

  function hitAt(event,near=false){
    const {left,top,width,height} = context.canvas.getBoundingClientRect();
    if(!width||!height||event.clientX<left||event.clientX>=left+width||event.clientY<top||event.clientY>=top+height)return {};
    const camera = context.getCamera();
    const cursor = new THREE.Vector2(event.clientX-left,event.clientY-top);
    const ndc = new THREE.Vector2();
    const pickAt = (x,y) => {
      raycaster.setFromCamera(ndc.set(x/width*2-1,1-y/height*2),camera);
      return raycaster.intersectObject(root,true).find(hit=>isVisible(hit.object)&&inLocalView(hit.object));
    };
    let hit = pickAt(cursor.x,cursor.y);
    if (!hit && near) {
      for (const [dx,dy] of [[5,0],[-5,0],[0,5],[0,-5]]) {
        hit = pickAt(cursor.x+dx,cursor.y+dy);
        if (hit) break;
      }
    }
    return {hit,cursor,camera,width,height};
  }
  function pick(event) {
    if (!active || gesture || saving || gizmo.dragging || (mode==='edit'&&topologyState==='loading')) return;
    const {hit,cursor,camera,width,height}=hitAt(event,mode==='edit'&&element!=='face');
    error = '';
    if (!hit?.face) {
      if (mode === 'object' && !event.shiftKey) {
        object = null;
        selectedObjects.clear();
      }
      selected.clear();
      updateSelection();
      return;
    }
    const owner = ownerOf(hit.object);
    if (!owner) return;
    if (mode === 'object') {
      selectObject(owner.userData.modelingId,event.shiftKey);
      return;
    }
    if (object !== owner || !event.shiftKey) selected.clear();
    if (object !== owner) {
      selectedObjects.clear();
      selectedObjects.add(owner);
    }
    object = owner;
    if (mode === 'edit') {
      const mesh = hit.object, {a,b,c} = hit.face;
      const screen = i => {
        point.fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(mesh.matrixWorld).project(camera);
        return new THREE.Vector2((point.x+1)*width/2,(1-point.y)*height/2);
      };
      const geometry = meshTopology(mesh);
      const polygonId = geometry?.polygonIds?.[hit.faceIndex];
      const polygon = geometry?.faces?.get(polygonId);
      let indices = polygon?.triangles || [a,b,c];
      if (element !== 'face') {
        const candidates = element === 'vertex'
          ? (polygon?.vertices||[a,b,c]).map(i=>[i])
          : polygon?.edges?.length?polygon.edges:[[a,b],[b,c],[c,a]];
        const ranked = candidates.map(list => ({list, distance:list.length === 1
          ? cursor.distanceTo(screen(list[0])) : segmentDistance(cursor,screen(list[0]),screen(list[1]))}));
        ranked.sort((first,second)=>first.distance-second.distance);
        indices = ranked[0].distance <= 16 ? ranked[0].list : [];
      }
      if (indices.length) {
        const key = element==='face' ? mesh.id+':face:'+(polygonId??hit.faceIndex)
          : indices.map(i=>vertexKey(mesh,i)).sort().join(',');
        if (selected.has(key)) selected.delete(key);
        else selected.set(key,{mesh,indices});
      }
    }
    updateSelection();
  }

  function visitElements(mesh,points,rect,choose){
    const {geometry}=mesh,topology=meshTopology(mesh);
    if(element==='vertex'){
      for(let i=0;i<geometry.attributes.position.count;i++)if(!rect||vertexInMarquee(points,i,rect))choose(vertexKey(mesh,i),[i]);
      return;
    }
    if(element==='edge'){
      const edge=(a,b)=>{
        if(!rect||edgeInMarquee(points,a,b,rect))choose([vertexKey(mesh,a),vertexKey(mesh,b)].sort().join(','),[a,b]);
      };
      if(topology?.edgeIndices){
        for(let i=0;i<topology.edgeIndices.length;i+=2)edge(topology.edgeIndices[i],topology.edgeIndices[i+1]);
      }else visitTriangles(geometry,(a,b,c)=>{edge(a,b);edge(b,c);edge(c,a);});
      return;
    }
    const face=(id,vertices,triangles)=>{
      if(!rect||faceCenterInMarquee(points,vertices,rect))choose(mesh.id+':face:'+id,triangles);
    };
    if(topology?.faces){
      for(const [id,polygon] of topology.faces)face(id,polygon.vertices,polygon.triangles);
    }else visitTriangles(geometry,(a,b,c,id)=>{const indices=[a,b,c];face(id,indices,indices);});
  }

  function selectElements(mesh,points,rect,subtract){
    visitElements(mesh,points,rect,(key,indices)=>{
      if(subtract)selected.delete(key);
      else selected.set(key,{mesh,indices});
    });
  }

  function canEditSelection(){
    return !!(active&&mode==='edit'&&object&&topologyState!=='loading'&&!gesture&&!saving&&!pendingOperation&&!gizmo.dragging);
  }
  function editMeshes(){
    return meshes.filter(mesh=>ownerOf(mesh)===object&&isVisible(mesh)&&inLocalView(mesh));
  }
  function selectLinked(event,subtract=false){
    if(!canEditSelection())return false;
    let seeds=selected.values();
    if(event){
      const {hit}=hitAt(event,true);
      if(!hit?.face||ownerOf(hit.object)!==object)return false;
      seeds=[{mesh:hit.object,indices:[hit.face.a,hit.face.b,hit.face.c]}];
    }else if(!selected.size)return false;
    const edit=editMeshes();
    if(connectedObject!==object){
      connectedGroup=connectedVertexGroups(connect=>{
        for(const mesh of edit){
          const keys=new Map();
          const vertex=i=>{if(!keys.has(i))keys.set(i,vertexKey(mesh,i));return keys.get(i);};
          visitTriangles(mesh.geometry,(a,b,c)=>connect(vertex(a),vertex(b),vertex(c)));
        }
      });
      connectedObject=object;
    }
    const groups=new Set();
    for(const {mesh,indices} of seeds)for(const i of indices)groups.add(connectedGroup(vertexKey(mesh,i)));
    for(const mesh of edit)visitElements(mesh,null,null,(key,indices)=>{
      if(!groups.has(connectedGroup(vertexKey(mesh,indices[0]))))return;
      if(subtract)selected.delete(key);
      else if(!selected.has(key))selected.set(key,{mesh,indices});
    });
    error='';selectionVersion++;updateSelection();return true;
  }

  function invertSelection(){
    if(!active||gesture||saving||pendingOperation||gizmo.dragging)return false;
    if(mode==='edit'){
      if(!canEditSelection())return false;
      const previous=new Set(selected.keys());
      selected.clear();
      for(const mesh of editMeshes())visitElements(mesh,null,null,(key,indices)=>{
        if(!previous.has(key)&&!selected.has(key))selected.set(key,{mesh,indices});
      });
    }else{
      for(const node of objects.values()){
        if(selectedObjects.has(node))selectedObjects.delete(node);
        else if(isVisible(node)&&inLocalView(node))selectedObjects.add(node);
      }
      object=[...selectedObjects].at(-1)||null;
    }
    error='';selectionVersion++;updateSelection();return true;
  }

  function boxSelect(rect,action){
    if(!active||gesture||saving||gizmo.dragging||(mode==='edit'&&(!object||topologyState==='loading')))return false;
    const camera=context.getCamera();
    camera.updateMatrixWorld();
    root.updateMatrixWorld(true);
    const clip=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const transform=new THREE.Matrix4(),subtract=action==='subtract';
    if(action==='replace'){
      if(mode==='object')selectedObjects.clear();
      else selected.clear();
    }
    const hits=new Set();
    for(const mesh of meshes){
      if(!isVisible(mesh)||!inLocalView(mesh))continue;
      const owner=ownerOf(mesh);
      if(!owner||(mode==='edit'?owner!==object:hits.has(owner)))continue;
      const points=projectMarqueeVertices(mesh.geometry.attributes.position,transform.multiplyMatrices(clip,mesh.matrixWorld));
      if(mode==='edit')selectElements(mesh,points,rect,subtract);
      else if(meshInMarquee(points,mesh.geometry,rect))hits.add(owner);
    }
    if(mode==='object'){
      for(const owner of hits){
        if(subtract)selectedObjects.delete(owner);
        else selectedObjects.add(owner);
      }
      if(!selectedObjects.has(object))object=[...selectedObjects].at(-1)||null;
    }
    error='';selectionVersion++;
    updateSelection();
    return true;
  }

  function selectAll(include=true){
    if(!active||gesture||saving||pendingOperation||gizmo.dragging)return false;
    if(mode==='edit'){
      if(!object||topologyState==='loading')return false;
      selected.clear();
      if(include)for(const mesh of meshes){
        if(ownerOf(mesh)===object&&isVisible(mesh)&&inLocalView(mesh))selectElements(mesh,null,null,false);
      }
    }else{
      selectedObjects.clear();
      if(include)for(const node of objects.values()){
        if(isVisible(node)&&inLocalView(node))selectedObjects.add(node);
      }
      if(!selectedObjects.has(object))object=[...selectedObjects].at(-1)||null;
    }
    error='';selectionVersion++;
    updateSelection();
    return true;
  }

  function selectObject(id, extend = false) {
    const node = objects.get(id);
    if (!active || gesture || saving || !node || !isVisible(node) || !inLocalView(node)) return;
    error = '';selectionVersion++;
    if (mode === 'object') {
      const next=objectClickSelection([...selectedObjects],object,node,extend);
      selectedObjects.clear();for(const item of next.selected)selectedObjects.add(item);
      object=next.active;
    } else if (object !== node) {
      selected.clear();
      selectedObjects.clear();
      selectedObjects.add(node);
      object = node;
    }
    updateSelection();
  }

  function isVisible(node) {
    for (let item=node;item;item=item.parent) if (!item.visible) return false;
    return true;
  }

  function inLocalView(node) {
    if (!localObjects) return true;
    for (let item=node;item;item=item.parent) if (localObjects.has(item)) return true;
    return false;
  }

  function applyLocalView() {
    for (const mesh of meshes) {
      mesh.layers.mask = inLocalView(mesh) ? mesh.userData.originalLayers : 0;
    }
    context.request();
  }

  function leaveLocalView() {
    if (!localObjects) return;
    const camera = localCamera;
    localObjects = localCamera = null;
    applyLocalView();
    if (camera) context.restoreCamera(camera);
  }

  function toggleLocalView() {
    if (!active || gesture || saving) return false;
    if (localObjects) {
      leaveLocalView();
      updateSelection();
      return true;
    }
    if (!selectedObjects.size) return false;
    localCamera = context.readCamera();
    localObjects = new Set(selectedObjects);
    applyLocalView();
    frameSelection();
    notify();
    return true;
  }

  function visibilityChanged() {
    for (const node of selectedObjects) if (!isVisible(node)) selectedObjects.delete(node);
    for (const [key,{mesh}] of selected) if (!isVisible(mesh)) selected.delete(key);
    if (object && !isVisible(object)) {
      object = [...selectedObjects].at(-1) || null;
      selected.clear();
    }
    error = '';
    updateSelection();
  }

  function toggleVisibility(id) {
    const node = objects.get(id);
    if (!active || gesture || saving || !node || !isVisible(node.parent) || !inLocalView(node)) return;
    node.visible = !node.visible;
    visibilityChanged();
  }

  function hideSelection() {
    if (!active || gesture || saving || !selectedObjects.size) return false;
    for (const node of selectedObjects) node.visible = false;
    visibilityChanged();
    return true;
  }

  function showAll() {
    if (!active || gesture || saving) return false;
    leaveLocalView();
    for (const node of objects.values()) node.visible = node.userData.originalVisibility;
    visibilityChanged();
    return true;
  }

  function setObjectVisibility(ids,visible){
    if(!active||gesture||saving||pendingOperation)return false;
    const nodes=ids.map(id=>objects.get(id)).filter(Boolean);
    if(visible&&localObjects)leaveLocalView();
    for(const node of nodes){node.visible=visible;if(visible)for(let parent=node.parent;parent&&parent!==root.parent;parent=parent.parent)parent.visible=true;}
    visibilityChanged();return true;
  }
  function frameObjects(ids){
    if(!active||gesture||saving||pendingOperation)return false;
    root.updateMatrixWorld(true);const bounds=new THREE.Box3();
    for(const id of ids){const node=objects.get(id);if(node)bounds.expandByObject(node);}
    if(bounds.isEmpty())return false;if(bounds.getSize(point).lengthSq()<.0001)bounds.expandByScalar(.05);
    context.frameBounds(bounds);return true;
  }

  function frameSelection(id) {
    if (id !== undefined) return frameObjects([id]);
    if (!active || gesture || saving || !object) return false;
    const bounds = new THREE.Box3();
    if (mode === 'edit' && selected.size) {
      for (const {mesh,indices} of selected.values()) {
        for (const index of indices) {
          bounds.expandByPoint(point.fromBufferAttribute(mesh.geometry.attributes.position,index).applyMatrix4(mesh.matrixWorld));
        }
      }
    } else {
      for (const node of selectedObjects) bounds.expandByObject(node);
    }
    if (bounds.isEmpty()) return false;
    if (bounds.getSize(point).lengthSq()<.0001) bounds.expandByScalar(.05);
    context.frameBounds(bounds);
    return true;
  }

  function capture(targets) {
    root.updateMatrixWorld(true);
    return targets.map(target => {
      if (target.id !== undefined) {
        const node = objects.get(target.id);
        return {node,world:node.matrixWorld.clone(),inverse:node.parent.matrixWorld.clone().invert()};
      }
      const mesh = meshes[target.mesh], geometry = mesh.geometry, position = geometry.attributes.position;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      return {mesh,position,bounds:geometry.boundingBox.clone(),world:mesh.matrixWorld.clone(),inverse:mesh.matrixWorld.clone().invert(),
        vertices:target.vertices, start:target.vertices.map(i=>new THREE.Vector3().fromBufferAttribute(position,i))};
    });
  }

  function apply(captured, delta, finish = false, normals = true) {
    for (const entry of captured) {
      const local = new THREE.Matrix4().multiplyMatrices(entry.inverse,delta).multiply(entry.world);
      if (entry.node) {
        entry.node.matrix.copy(local);
        entry.node.matrixWorldNeedsUpdate = true;
      } else {
        const geometry = entry.mesh.geometry;
        // The original box covers untouched vertices; expand it only with the
        // moved vertices during a gesture. Reset from the captured box each
        // frame so reversing a gesture does not retain its previous extent.
        if (!finish) geometry.boundingBox.copy(entry.bounds);
        for (const [offset,i] of entry.vertices.entries()) {
          point.copy(entry.start[offset]).applyMatrix4(local);
          entry.position.setXYZ(i,point.x,point.y,point.z);
          if (!finish) geometry.boundingBox.expandByPoint(point);
        }
        entry.position.needsUpdate = true;
        if (finish) {
          if (normals) geometry.computeVertexNormals();
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
        } else geometry.boundingBox.getBoundingSphere(geometry.boundingSphere ||= new THREE.Sphere());
      }
    }
    root.updateMatrixWorld(true);
  }

  function replay() {
    root.traverse(node => {
      const original = node.userData.original;
      node.matrix.copy(original.matrix);
      node.matrixWorldNeedsUpdate = true;
      if (!node.isMesh) return;
      const geometry = node.geometry;
      for (const name of ['position','normal']) {
        const attribute = geometry.attributes[name];
        if (!attribute || !original.geometry.attributes[name]) continue;
        attribute.copy(original.geometry.attributes[name]);
        attribute.needsUpdate = true;
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    });
    for (const step of undo) {
      if(step.type==='vertexPositions')applyVertexPositions(step.targets);
      else apply(capture(step.targets),new THREE.Matrix4().fromArray(step.matrix),true);
    }
    context.updateModelBounds();
    updateSelection();
  }

  function readDraft() {
    let raw;
    // A missing modeling field is authoritative too: undoing the first
    // transform restores the original model. Never resurrect its stale cache.
    try { raw = project.save ? JSON.stringify(project.read?.()?.modeling?.steps || []) : localStorage.getItem(storageKey); }
    catch { return false; }
    if (storageSnapshot === raw) return false;
    storageSnapshot = raw;
    let steps;
    try { steps = JSON.parse(raw); }
    catch { steps = null; }
    undo = Array.isArray(steps) ? steps.filter(validStep) : [];
    redo = [];
    return true;
  }

  async function saveDraft(nextUndo, nextRedo, needsReplay) {
    const expectedRevision=project.read?.()?.revision,expectedProject=currentProject;
    saving = true;
    if (gizmo) gizmo.enabled = false;
    notify();
    const write = async () => {
      if (readDraft()) {
        error = project.save?'工程建模已更新，请基于新版本重试':'另一个标签页已更新建模草稿，请基于新版本重试';
        return false;
      }
      try {
        const raw = JSON.stringify(nextUndo);
        if (project.save) {
          let topology=topologyMeta;
          if(nextUndo.some(step=>step.targets.some(target=>target.mesh!==undefined))&&!topology)
            topology=(await loadModelTopology(currentProject)).primitives;
          const nativeSteps=nextUndo.map(step=>modelStepForSource(step,target=>{
            const mesh=meshes[target.mesh],node=target.id!==undefined?objects.get(target.id):ownerOf(mesh);
            const object=node?.userData.original?.userData.modelingLabel;
            if(target.id!==undefined)return {object};
            const primitive=mesh.userData.original.userData.modelingPrimitive;
            return {object,vertices:target.vertices.map(id=>topology?.[primitive]?.vertices[id])};
          }));
          const version=nextUndo.some(step=>step.type==='vertexPositions')?2:1;
          await project.save({version,binding:context.binding,modelSha256:context.modelSha256,steps:nextUndo,nativeSteps},expectedRevision,expectedProject);
          // Local cache is optional after the authoritative project commit.
          try{localStorage.setItem(storageKey,raw);}catch{}
        }else localStorage.setItem(storageKey,raw);
        storageSnapshot = raw;
        undo = nextUndo;
        redo = nextRedo;
        error = '';
      } catch (failure) {
        error = failure.message || '建模修改保存失败';
        readDraft();
        return false;
      }
      return true;
    };
    let saved = false;
    try {
      saved = navigator.locks ? await navigator.locks.request(storageKey,write) : await write();
    } catch {
      error = '无法保存建模修改，请重试';
    } finally {
      saving = false;
      if (gizmo) gizmo.enabled = showGizmo;
      const updated = active && saved && readDraft();
      if (updated) error = '已同步另一个标签页的建模草稿';
      if (active && (!saved || needsReplay || updated)) replay();
      else notify();
    }
    return saved;
  }

  function trackOperation(task){
    pendingOperation=task;
    const settle=(saved,failure)=>{
      if(pendingOperation!==task)return;
      pendingOperation=null;
      if(!active){queuedHistory=[];return;}
      if(!saved){
        if(queuedHistory.length)error=(error||failure?.message||'修改未保存')+'，已取消排队的撤销／重做';
        else if(failure)error=failure.message||'历史操作失败';
        queuedHistory=[];notify();return;
      }
      const next=queuedHistory.shift();
      if(next&&next.projectId===currentProject&&next.binding===storageKey)travel(next.direction);
      else{queuedHistory=[];notify();}
    };
    void task.then(saved=>settle(saved),failure=>settle(false,failure));
  }

  window.addEventListener('storage',event=>{
    if (project.save || !active || gesture || saving || event.storageArea!==localStorage ||
        (event.key!==storageKey && event.key!==null) || !readDraft()) return;
    error = '已同步另一个标签页的建模草稿';
    replay();
  },{signal:project.signal});

  function validStep(step) {
    if (!Array.isArray(step?.targets) || !step.targets.length) return false;
    if (step.type==='vertexPositions')
      return step.targets.every(target=>validVertices(target)&&Array.isArray(target.positions)&&
        target.positions.length===target.vertices.length*3&&target.positions.every(Number.isFinite));
    if (!Array.isArray(step.matrix) || step.matrix.length !== 16 || !step.matrix.every(Number.isFinite)) return false;
    return step.targets.every(target=>objects.has(target?.id) ||
      validVertices(target));
  }

  function validVertices(target) {
    return meshes[target?.mesh] && Array.isArray(target.vertices) && target.vertices.length &&
      target.vertices.every(i=>Number.isInteger(i)&&i>=0&&i<meshes[target.mesh].geometry.attributes.position.count);
  }

  function applyVertexPositions(targets) {
    for (const target of targets) {
      const {geometry}=meshes[target.mesh];
      writeVertexPositions(geometry.attributes.position,target);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
  }

  function canSmooth() {
    return active&&mode==='edit'&&topologyState==='ready'&&selected.size>0&&
      project.read?.()?.source.format==='glb'&&!gesture&&!saving&&!pendingOperation;
  }

  async function smooth(options) {
    if (!canSmooth()) throw Error('请选择原生 GLB 工程中的网格元素');
    const primitives=meshes.filter(mesh=>ownerOf(mesh)===object).map(mesh=>({mesh,geometry:mesh.geometry,topology:meshTopology(mesh)}));
    const ids=new Set();
    for (const {mesh,indices} of selected.values())
      for (const index of indices) ids.add(meshTopology(mesh).vertices[index]);
    const result=smoothSelectedVertices(primitives,ids,{...options,axes:[options.axes[0],options.axes[2],options.axes[1]]});
    if (!result.size) throw Error('选中的顶点没有可平滑的位置');
    const targets=[];
    for (const {mesh,topology} of primitives) {
      const vertices=[],positions=[];
      topology.vertices.forEach((id,index)=>{
        const next=result.get(id);
        if(next){vertices.push(index);positions.push(next.x,next.y,next.z);}
      });
      if(vertices.length)targets.push({mesh:mesh.userData.modelingMesh,vertices,positions});
    }
    const step={type:'vertexPositions',targets};
    if (JSON.stringify(step).length>2*1024*1024) throw Error('平滑选区过大，请分批修改');
    applyVertexPositions(targets);
    const task=saveDraft([...undo,step],[],false);
    trackOperation(task);
    context.updateModelBounds();updateSelection();
    if (!await task) throw Error(error||'平滑修改未保存');
  }

  function startTransform() {
    error = '';
    gesture = {targets:selectionTargets(),inverse:pivot.matrixWorld.clone().invert(),delta:identity.clone()};
    gesture.captured = capture(gesture.targets);
    context.setNavigation(false);
    notify();
  }

  function previewTransform() {
    if (!gesture) return;
    pivot.updateMatrixWorld(true);
    const delta = new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld,gesture.inverse);
    if (!delta.elements.every(Number.isFinite) || Math.abs(delta.determinant()) < 1e-8) return;
    gesture.delta = delta;
    apply(gesture.captured,delta);
    context.updateModelBounds();
    updateHelpers();
    makeSelectionOverlay();
    context.request();
  }

  function finishTransform(cancel = false) {
    if (!gesture) return;
    if(gesture.keyboard&&!cancel)updateKeyboardTransform();
    const {targets,captured,delta,keyboard,events,guides=[]} = gesture;
    if(gesture.frame!=null)cancelAnimationFrame(gesture.frame);
    gesture = null;
    events?.abort();
    for(const guide of guides){guide.removeFromParent();guide.geometry.dispose();guide.material.dispose();}
    if(keyboard)gizmo.enabled=showGizmo;
    const changed = !cancel && delta.elements.some((n,i)=>Math.abs(n-identity.elements[i])>1e-7);
    apply(captured,changed?delta:identity,true,changed);
    context.setNavigation(true);
    if (changed) recordTransform(targets,delta);
    else if (readDraft()) {
      error = '已同步另一个标签页的建模草稿';
      replay();
      return;
    }
    context.updateModelBounds();
    updateSelection();
  }

  function updateKeyboardTransform(){
    if(!gesture?.keyboard)return;
    if(gesture.frame!=null){cancelAnimationFrame(gesture.frame);gesture.frame=null;}
    const session=gesture.keyboard,delta=session.result(),state=session.describe();
    if(delta){gesture.delta=delta;apply(gesture.captured,delta);context.updateModelBounds();updateHelpers();makeSelectionOverlay();}
    const key=[state.orientation,state.axis,state.exclude].join(':');
    if(gesture.guideKey!==key){
      for(const guide of gesture.guides){guide.removeFromParent();guide.geometry.dispose();guide.material.dispose();}
      gesture.guideKey=key;gesture.guides=[];
      for(const {axis,direction} of session.guide()){
        const segment=constraintSegment(context.getCamera(),gesture.center,direction);if(!segment)continue;
        const geometry=new THREE.BufferGeometry().setFromPoints(segment);
        const guide=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:axisColors[axis],transparent:true,opacity:.5,depthTest:false,depthWrite:false,toneMapped:false}));
        guide.name='Transform Constraint '+axis;guide.frustumCulled=false;
        guide.renderOrder=999999;overlaysGroup.add(guide);gesture.guides.push(guide);
      }
    }
    context.request();notify();
  }

  function consumeFollowup(type){
    const stop=event=>{event.preventDefault();event.stopImmediatePropagation();clearTimeout(timer);};
    const timer=setTimeout(()=>window.removeEventListener(type,stop,true),1500);
    window.addEventListener(type,stop,{capture:true,once:true});
  }

  function transformKey(event,pointer){
    const next={g:'translate',r:'rotate',s:'scale'}[event.key.toLowerCase()];
    if(!next||event.repeat||event.ctrlKey||event.metaKey||event.altKey||!active||gesture||saving||pendingOperation||!object||
      mode==='edit'&&(!selected.size||topologyState==='loading'))return false;
    const rect=context.canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return false;
    tool=next;gizmo.setMode(next);startTransform();
    gesture.center=selectionCenter();gesture.guides=[];
    gesture.keyboard=createModelTransform({tool,pivot:gesture.center,orientation,localFrame:modelOrientation(object,'local'),camera:context.getCamera(),rect,pointer});
    const events=gesture.events=new AbortController(),signal=events.signal;
    gizmo.detach();gizmo.enabled=false;context.canvas.focus({preventScroll:true});
    const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
    window.addEventListener('pointermove',event=>{stop(event);gesture.keyboard.move(event);
      if(gesture.frame==null)gesture.frame=requestAnimationFrame(()=>{if(gesture?.keyboard)updateKeyboardTransform();});
    },{capture:true,signal});
    window.addEventListener('pointerdown',event=>{
      if(![0,2].includes(event.button))return;stop(event);consumeFollowup('pointerup');
      if(event.button===2){consumeFollowup('contextmenu');cancelTransform();}
      else if(gesture.keyboard.result())finishTransform();else updateKeyboardTransform();
    },{capture:true,signal});
    window.addEventListener('keydown',event=>{
      const key=event.key.toLowerCase(),session=gesture.keyboard;
      if(key==='escape'||(event.metaKey||event.ctrlKey)&&key==='z'){stop(event);cancelTransform();return;}
      if(key==='enter'){stop(event);if(session.result())finishTransform();else updateKeyboardTransform();return;}
      if(!event.metaKey&&(!event.ctrlKey||['control','shift'].includes(key))&&session.key(event)){
        stop(event);session.modifiers(event);updateKeyboardTransform();return;
      }
      if(['shift','control','meta'].includes(key)){stop(event);session.modifiers(event);updateKeyboardTransform();}
      else if(!event.metaKey&&!event.ctrlKey)stop(event);
    },{capture:true,signal});
    window.addEventListener('keyup',event=>{if(['Shift','Control','Meta'].includes(event.key)){stop(event);gesture.keyboard.modifiers(event);updateKeyboardTransform();}},{capture:true,signal});
    window.addEventListener('blur',cancelTransform,{signal});
    window.addEventListener('resize',cancelTransform,{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelTransform();},{signal});
    window.addEventListener('wheel',stop,{capture:true,passive:false,signal});
    updateKeyboardTransform();return true;
  }

  function recordTransform(targets, delta) {
    const task=saveDraft([...undo,{targets,matrix:delta.toArray()}],[],false);trackOperation(task);return task;
  }

  function inspectObject(id){
    if(!active)return null;const node=objects.get(id);if(!node)return null;
    node.updateWorldMatrix(true,false);
    const position=node.getWorldPosition(new THREE.Vector3()).applyQuaternion(worldAxes.clone().invert()).toArray();
    return {id,label:node.userData.original.userData.modelingLabel||node.name||'未命名物体',position,visible:isVisible(node),binding:context.binding};
  }

  async function transformObject(id,kind,values,space='global'){
    if(!active||gesture||saving||pendingOperation)throw Error('请先完成当前建模操作');
    if(mode!=='object')throw Error('请先切换到物体模式');
    const node=objects.get(id);if(!node)throw Error('固定物体已不可用');
    if(!['global','local'].includes(space))throw Error('变换坐标系无效');
    root.updateMatrixWorld(true);
    const delta=numericModelDelta(kind,values,objectOriginCenter([node]),modelOrientation(node,space));
    if(!delta.elements.some((value,i)=>Math.abs(value-identity.elements[i])>1e-7))return true;
    const targets=[{id}];apply(capture(targets),delta,true);
    const task=recordTransform(targets,delta);context.updateModelBounds();updateSelection();
    if(!await task)throw Error(error||'建模修改未保存');return true;
  }

  function applyNumeric(values) {
    if (!active || gesture || saving || !object || (mode==='edit'&&!selected.size)) return false;
    const delta = numericModelDelta(tool,values,selectionCenter(),modelOrientation(object,orientation));
    if (!delta.elements.some((value,i)=>Math.abs(value-identity.elements[i])>1e-7)) return false;
    const targets = selectionTargets();
    apply(capture(targets),delta,true);
    recordTransform(targets,delta);
    context.updateModelBounds();
    updateSelection();
    return true;
  }

  function cancelTransform() {
    if (!gesture) return false;
    finishTransform(true);
    gizmo.pointerUp(null);
    return true;
  }

  function open(view, projectId) {
    if (!view || active) return;
    context = view;
    currentProject = projectId;
    const key = 'arachne-model-draft-v1:'+projectId+':'+view.binding;
    if (key !== storageKey) {
      storageKey = key;
      storageSnapshot = undefined;
      undo = [];
      redo = [];
      mode = 'object';
      element = 'vertex';
      tool = 'translate';
    }
    let index = 0;
    function cloneNode(original, hasOwner = false) {
      index++;
      const node = original.isMesh
        ? new THREE.Mesh(original.geometry.clone(),original.material) : new THREE.Group();
      node.userData = {original,originalVisibility:original.visible,originalLayers:original.layers.mask};
      node.layers.mask = original.layers.mask;
      node.name = original.name;
      node.visible = original.visible;
      node.matrix.copy(original.matrix);
      node.matrixAutoUpdate = false;
      if (original.userData.modelingObject !== undefined || (node.isMesh && !hasOwner)) {
        const id = original.userData.modelingObject ?? -index;
        node.userData.modelingId = id;
        objects.set(id,node);
        hasOwner = true;
      }
      if (node.isMesh) {
        node.castShadow = original.castShadow;
        node.receiveShadow = original.receiveShadow;
        node.userData.modelingMesh = meshes.push(node)-1;
      }
      for (const child of original.children) node.add(cloneNode(child,hasOwner));
      return node;
    }
    root = cloneNode(view.model);
    sceneItems = [...objects].map(([id,node])=>{
      let depth = 0, parentId = null;
      for (let parent=node.parent;parent;parent=parent.parent) {
        if (parent.userData.modelingId!==undefined) {if(parentId===null)parentId=parent.userData.modelingId;depth++;}
      }
      return {id,label:node.userData.original.userData.modelingLabel||node.name||'未命名物体',depth,parentId};
    });
    decorations = new THREE.Group();
    pivot = new THREE.Object3D();
    decorations.add(pivot);
    gizmo = new TransformControls(view.getCamera(),view.canvas);
    gizmo.setColors(axisColors.X,axisColors.Y,axisColors.Z,'#ffffff');
    gizmo.setSize(.75);
    // The pivot supplies the chosen Blender frame, including Z-up mapping.
    // Three's native 'world' frame would swap Blender's Y/Z directions.
    gizmo.setSpace('local');
    gizmo.setMode(tool);
    gizmo.enabled=showGizmo;
    gizmoGroup = new THREE.Group();
    gizmoGroup.visible=showGizmo;
    gizmoGroup.add(gizmo.getHelper());
    overlaysGroup = new THREE.Group();
    overlaysGroup.visible=showOverlays;
    origins = createObjectOrigins();
    overlaysGroup.add(origins.group);
    decorations.add(gizmoGroup,overlaysGroup);
    view.scene.add(decorations);
    view.showModelingPreview(root);
    gizmo.addEventListener('change',view.request);
    gizmo.addEventListener('mouseDown',startTransform);
    gizmo.addEventListener('objectChange',previewTransform);
    gizmo.addEventListener('mouseUp',()=>finishTransform());
    view.canvas.addEventListener('pointercancel',cancelTransform);
    active = true;
    readDraft();
    undo = undo.filter(validStep);
    if (undo.length) replay();
    else updateSelection();
    if (mode==='edit') void prepareTopology(projectId);
  }

  function close() {
    if (!active) return;
    cancelTransform();
    leaveLocalView();
    active = false;
    topologyRequest?.abort();
    topologyRequest = null;
    topologyState = 'idle';
    topologyMeta = null;
    connectedObject = connectedGroup = null;
    primitiveCache = new WeakMap();
    objectAliases = new WeakMap();
    clearHelpers();
    context.setObjectOutline?.([]);
    gizmo.dispose();
    origins.dispose();
    context.canvas.removeEventListener('pointercancel',cancelTransform);
    decorations.removeFromParent();
    context.showModelingPreview(null);
    for (const mesh of meshes) mesh.geometry.dispose();
    meshes.length = 0;
    objects.clear();
    sceneItems = [];
    object = null;
    selected.clear();
    selectedObjects.clear();
    error = '';
    queuedHistory=[];pendingOperation=null;
    root = context = decorations = gizmo = pivot = origins = null;
    notify();
  }

  function travel(direction) {
    if (!active || gesture || !['undo','redo'].includes(direction)) return;
    if(saving||pendingOperation){queuedHistory.push({direction,projectId:currentProject,binding:storageKey});notify();return;}
    if(project.travel){
      saving=true;gizmo.enabled=false;notify();
      trackOperation((async()=>{
        let saved=false;
        try{await project.travel(direction);error='';saved=true;}
        catch(failure){error=failure.message;}
        finally{saving=false;gizmo.enabled=showGizmo;readDraft();replay();}
        return saved;
      })());
      return;
    }
    if (direction === 'undo' && undo.length) trackOperation(saveDraft(undo.slice(0,-1),[...redo,undo.at(-1)],true));
    if (direction === 'redo' && redo.length) trackOperation(saveDraft([...undo,redo.at(-1)],redo.slice(0,-1),true));
  }

  async function exportDraft() {
    if (!active || gesture || saving || !undo.length) throw Error('请先完成建模变换');
    const materials = new Map();
    const geometry = [];
    function materialCopy(original) {
      if (!materials.has(original)) materials.set(original,context.sourceMaterialForExport(original));
      return materials.get(original);
    }
    function snapshot(node) {
      let copy;
      if (node.isMesh) {
        const source = node.userData.original;
        const original = source.userData.viewportOriginalMaterials || source.material;
        const material = Array.isArray(original) ? original.map(materialCopy) : materialCopy(original);
        const shape = node.geometry.clone();
        geometry.push(shape);
        copy = new THREE.Mesh(shape,Array.isArray(material)&&material.length===1?material[0]:material);
      } else copy = new THREE.Group();
      copy.name = node.name;
      copy.visible = node.userData.originalVisibility;
      copy.matrix.copy(node.matrix);
      copy.matrixAutoUpdate = false;
      for (const child of node.children) copy.add(snapshot(child));
      return copy;
    }
    try {
      const draft = snapshot(root);
      const {GLTFExporter} = await import('three/addons/exporters/GLTFExporter.js');
      return await new GLTFExporter().parseAsync(draft,{binary:true});
    } finally {
      for (const shape of geometry) shape.dispose();
      for (const material of materials.values()) material.dispose();
    }
  }

  return {
    syncDocument(){if(active&&!gesture&&!saving&&readDraft()){error='已同步工程建模修改';replay();}},
    setObjectSelection(ids,activeId){if(!active||gesture||saving)return;selected.clear();selectedObjects.clear();for(const id of ids){const node=objects.get(id);if(node&&isVisible(node)&&inLocalView(node))selectedObjects.add(node);}const target=objects.get(activeId);object=selectedObjects.has(target)?target:[...selectedObjects].at(-1)||null;updateSelection();},
    open,close,pick,boxSelect,selectAll,selectLinked,invertSelection,selectObject,frameSelection,frameObjects,setObjectVisibility,toggleVisibility,hideSelection,showAll,toggleLocalView,applyNumeric,inspectObject,transformObject,canSmooth,smooth,travel,exportDraft,cancelTransform,transformKey,isDragging:()=>!!gesture||saving||!!pendingOperation,
    setDisplayHelpers({overlays,transform}){
      showOverlays=overlays;showGizmo=transform;
      if(!active)return;
      overlaysGroup.visible=showOverlays;gizmoGroup.visible=showGizmo;
      if(!saving&&!gesture)gizmo.enabled=showGizmo;
      context.request();
    },
    syncCamera(){ if (active) gizmo.camera = context.getCamera(); },
    syncPivot(){if(active&&pivotMode==='cursor'&&!gesture&&!saving)updateSelection();},
    selectionOrigin(){
      if(!active||!object||mode==='edit'&&!selected.size)return null;
      return selectionCenter('median').applyQuaternion(worldAxes.clone().invert()).toArray();
    },
    toggleMode(){ if (active) this.setMode(mode === 'object' ? 'edit' : 'object'); },
    setMode(next){
      if (!active || gesture || saving || next === mode) return;
      mode = next;
      selected.clear();
      updateSelection();
      if (mode==='edit') void prepareTopology(currentProject);
    },
    setElement(next){
      if (!active || gesture || saving || mode !== 'edit' || next === element) return;
      element = next;
      selected.clear();
      updateSelection();
    },
    setTool(next){
      if (!active || gesture || saving) return;
      tool = next;
      gizmo.setMode(next);
      notify();
    },
    setOrientation(next){
      if (!['global','local'].includes(next) || gesture || saving) return false;
      orientation=next;
      if(active)updateSelection();
      return true;
    },
    setPivot(next){
      if(!Object.hasOwn(modelPivotLabels,next)||gesture||saving)return false;
      if(next===pivotMode)return true;
      pivotMode=next;
      if(active)updateSelection();
      return true;
    }
  };
}
