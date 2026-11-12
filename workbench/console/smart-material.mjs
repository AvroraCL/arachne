import {randomUUID} from 'node:crypto';
import {layerParent,layerTreeOrder} from './public/paint-layer-tree.mjs';
import {compileLibraryMaterial,libraryOperation} from './public/paint-library.mjs';
import {imageDocumentLimit} from './public/image-documents.mjs';
import {smartMaterialPlacement} from './public/smart-material-placement.mjs';

export function captureSmartMaterial(paint, groupId) {
  const group=paint.layers.find(layer=>layer.id===groupId);
  if(group?.kind!=='group')throw Error('请在材质图层中选择文件夹');
  const layers=[group,...layerTreeOrder(paint.layers,groupId)];
  if(!layers.some(layer=>layer.kind!=='group'))throw Error('请先在文件夹中添加材质图层');
  const materials={},documents={};
  for(const layer of layers){
    const spatial=layer.kind==='decal'&&layer.space!=='uv'||
      [...(layer.strokes||[]),...(layer.maskStrokes||[])].some(stroke=>stroke.uv!==true&&!stroke.transformUV&&!stroke.clearUV);
    if(spatial)throw Error('「'+layer.name+'」包含绑定原模型的笔触或投影。可用 UV 贴图或生成器制作可复用的图层。');
    if(layer.materialId){
      const material=paint.materials[layer.materialId];
      compileLibraryMaterial(material.graph,paint.assets);
      materials[layer.materialId]=material;
    }
    for(const id of Object.values(layer.documentMaps??{})){
      if(!Object.hasOwn(paint.imageDocuments??{},id))throw Error('「'+layer.name+'」引用的贴图已不存在');
      documents[id]=paint.imageDocuments[id];
    }
  }
  const preset=structuredClone({version:1,layers,materials,documents});
  preset.layers[0].parentId=null;
  return preset;
}

export function smartMaterialAssets(preset) {
  const ids=new Set();
  for(const layer of preset.layers){
    for(const id of [layer.image,layer.mask,...Object.values(layer.maps??{})])if(id)ids.add(id);
  }
  for(const material of Object.values(preset.materials))
    for(const node of material.graph.nodes)if(node.type==='image'&&node.params.asset)ids.add(node.params.asset);
  for(const doc of Object.values(preset.documents))
    for(const layer of doc.layers)if(layer.kind==='image')ids.add(layer.asset);
  return ids;
}

export function applySmartMaterial(paint, preset, name, placement) {
  if(preset?.version!==1||preset.layers[0]?.kind!=='group')throw Error('智能材质格式无效');
  const target=placement&&smartMaterialPlacement(paint.layers,placement.targetId,placement.zone);
  if(placement&&!target)throw Error('智能材质的放置位置已变化或被锁定');
  if(paint.layers.length+preset.layers.length>64)throw Error('应用智能材质后会超过 64 个材质图层');
  if(Object.keys(paint.imageDocuments??{}).length+Object.keys(preset.documents).length>imageDocumentLimit)
    throw Error('应用智能材质后会超过 16 个贴图文档');
  const ids=new Map(preset.layers.map(layer=>[layer.id,randomUUID()]));
  const materials=new Map(Object.keys(preset.materials).map(id=>[id,randomUUID()]));
  const documents=new Map(Object.keys(preset.documents).map(id=>[id,randomUUID()]));
  for(const [id,resource] of Object.entries(preset.materials))
    libraryOperation(paint,{op:'library',library:'materials',id:materials.get(id),action:'create',patch:structuredClone(resource)});
  for(const [id,document] of Object.entries(preset.documents)){
    const images=paint.imageDocuments??={};
    const copy=structuredClone(document);
    const taken=new Set(Object.values(images).map(image=>image.name));
    for(let i=2;taken.has(copy.name);i++){
      const suffix=' · '+i;
      copy.name=document.name.slice(0,100-suffix.length)+suffix;
    }
    images[documents.get(id)]=copy;
  }
  const copies=preset.layers.map(layer=>{
    const copy=structuredClone(layer),parent=layerParent(copy);
    copy.id=ids.get(copy.id);
    copy.parentId=parent===null?null:ids.get(parent);
    if(copy.materialId)copy.materialId=materials.get(copy.materialId);
    if(copy.documentMaps)copy.documentMaps=Object.fromEntries(Object.entries(copy.documentMaps).map(([channel,id])=>[channel,documents.get(id)]));
    return copy;
  });
  copies[0].name=name;
  if(target){
    copies[0].parentId=target.parentId;
    const index=target.zone==='inside'?paint.layers.length:
      paint.layers.findIndex(layer=>layer.id===target.targetId)+(target.zone==='above'?1:0);
    paint.layers.splice(index,0,...copies);
    paint.layers=layerTreeOrder(paint.layers);
  }else paint.layers.push(...copies);
  return copies[0].id;
}
