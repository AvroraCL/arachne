export const layerParent=layer=>layer.parentId??null;
export const layerChildren=(layers,parentId)=>layers.filter(layer=>layerParent(layer)===parentId);

export function layerTreeOrder(layers,parentId=null){
  return layerChildren(layers,parentId).flatMap(layer=>[
    layer,...(layer.kind==='group'?layerTreeOrder(layers,layer.id):[])
  ]);
}

export function layerTreeRows(layers,{query='',collapsed=new Set(),filter=null}={}){
  const normalize=name=>name.trim().normalize('NFKC').toLocaleLowerCase();
  const needle=normalize(query),children=new Map();
  for(const layer of layers){
    const parent=layerParent(layer);
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(layer);
  }
  function walk(parent,depth,ancestorMatches,parentVisible,lockedBy){
    const rows=[];
    for(const layer of (children.get(parent)||[]).slice().reverse()){
      const matches=ancestorMatches||(!filter||filter(layer))&&normalize(layer.name).includes(needle);
      const open=layer.kind==='group'&&(!!needle||!!filter||!collapsed.has(layer.id));
      const visible=parentVisible&&layer.visible,lockOwner=lockedBy||(layer.locked?layer:null);
      const descendants=open?walk(layer.id,depth+1,matches,visible,lockOwner):[];
      if(!matches&&!descendants.length)continue;
      rows.push({layer,depth,open,visible,lockOwner},...descendants);
    }
    return rows;
  }
  return walk(null,0,false,true,null);
}
export const materialLayerRows=layerTreeRows;

export function layerIsVisible(layers,layer){
  if(!layer?.visible)return false;
  for(let parent=layerParent(layer);parent!==null;){
    const folder=layers.find(item=>item.id===parent);
    if(!folder?.visible)return false;
    parent=layerParent(folder);
  }
  return true;
}

export function layerLockOwner(layers,layer){
  let owner=null;
  for(let item=layer;item;){
    if(item.locked)owner=item;
    const parent=layerParent(item);
    item=parent===null?null:layers.find(candidate=>candidate.id===parent);
  }
  return owner;
}
