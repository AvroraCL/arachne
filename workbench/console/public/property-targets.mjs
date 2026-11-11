// A pin records an identity, never a mutable project object or a revision snapshot.
export function validPropertyTarget(category,target){
  if(!target||typeof target!=='object'||typeof target.projectId!=='string'||!target.projectId)return false;
  if(category==='render'||category==='output')return true;
  if(category==='object')return (typeof target.id==='number'&&Number.isFinite(target.id)||typeof target.id==='string'&&!!target.id)&&typeof target.binding==='string'&&!!target.binding;
  const hasLayer=Object.hasOwn(target,'layerId')&&(target.layerId===null||typeof target.layerId==='string'&&!!target.layerId);
  if(category==='material')return target.kind==='resource'?typeof target.resourceId==='string'&&!!target.resourceId:hasLayer&&['material','mask'].includes(target.target);
  if(category==='drawing')return hasLayer&&typeof target.documentId==='string'&&!!target.documentId&&['pixels','mask'].includes(target.target);
  return false;
}

export function capturePropertyTarget(category,project,materialSelection){
  const doc=project.document;if(!doc)return null;
  if(category==='render'||category==='output')return {projectId:doc.id};
  if(category==='object'){
    const scene=project.scene;if(scene?.projectId!==doc.id||scene.activeId==null||!scene.binding)return null;
    const info=scene.inspectObject?.(scene.activeId);return info?{projectId:doc.id,id:info.id,binding:info.binding,name:info.label}:null;
  }
  if(category==='material'){
    const selected=materialSelection?.()||{layerId:project.layerId};
    if(selected.kind==='resource'&&selected.resourceId)return {projectId:doc.id,kind:'resource',resourceId:selected.resourceId};
    return {projectId:doc.id,layerId:selected.layerId??null,target:selected.target==='mask'?'mask':'material'};
  }
  if(category==='drawing'){
    const selected=project.imageContext;if(!selected?.documentId)return null;
    return {projectId:doc.id,documentId:selected.documentId,layerId:selected.layerId??null,target:selected.target==='mask'?'mask':'pixels'};
  }
  return null;
}

export function propertyTargetStatus(category,project,target){
  const doc=project.document;
  if(!doc)return {available:false,reason:'请先打开工程'};
  if(!target)return {available:false,reason:category==='object'?'请在物体模式中选择物体':category==='drawing'?'请选择图像文档或绘制图层':'没有可用的属性目标'};
  if(!validPropertyTarget(category,target))return {available:false,reason:'属性目标无效，请取消固定后重新选择'};
  if(target.projectId!==doc.id)return {available:false,reason:'固定的属性属于其他工程'};
  if(category==='render'||category==='output')return {available:true,type:'场景',name:doc.name};
  if(category==='object'){
    const scene=project.scene;
    if(!scene||scene.projectId!==doc.id)return {available:false,reason:'请打开建模三维视口以查看物体'};
    if(scene.binding!==target.binding)return {available:false,reason:'模型绑定已变化，请取消固定后重新选择'};
    const info=scene.inspectObject?.(target.id);
    if(info)return {available:true,type:'物体',name:info.label,info};
    return {available:false,reason:scene.sceneItems?.some(item=>item.id===target.id)?'请切换到物体模式以查看此物体':'固定的物体已不存在'};
  }
  if(category==='material'){
    if(target.kind==='resource'){
      const resource=doc.paint.materials?.[target.resourceId];
      return resource?{available:true,type:'材质资源',name:resource.name,resource}:{available:false,reason:'固定的材质资源已不存在'};
    }
    const layer=target.layerId==null?null:doc.paint.layers.find(item=>item.id===target.layerId);
    if(target.layerId!=null&&!layer)return {available:false,reason:'固定的材质图层已不存在'};
    return {available:true,type:target.target==='mask'?'材质蒙版':'材质图层',name:layer?.name||'全 UV 底层',layer};
  }
  if(category==='drawing'){
    const image=doc.paint.imageDocuments?.[target.documentId];
    const layer=target.layerId==null?null:image?.layers.find(item=>item.id===target.layerId);
    if(!image||target.layerId!=null&&!layer)return {available:false,reason:'固定的图像文档或绘制图层已不存在'};
    return {available:true,type:target.target==='mask'?'图层蒙版':'绘制图层',name:layer?.name||image.name,image,layer};
  }
  return {available:false,reason:'未知属性类型'};
}
