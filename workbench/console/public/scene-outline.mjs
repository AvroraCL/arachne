// A view of registered objects; filtering and folding never change project data.
const searchText=value=>value.normalize('NFKC').trim().toLocaleLowerCase();
export function outlineNameMatches(item,query){
  const needle=searchText(query);
  return !needle||[item.label,item.sourceLabel].some(label=>label&&searchText(label).includes(needle));
}
function outlineTree(items){
  const byId=new Map(items.map(item=>[item.id,item])),children=new Map();
  for(const item of items){
    const parent=byId.has(item.parentId)&&item.parentId!==item.id?item.parentId:null;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(item);
  }
  return {byId,children};
}
export function outlineBranches(items,rootId=null){
  const {children}=outlineTree(items),branches=new Set(),pending=[rootId];
  while(pending.length){
    const id=pending.pop(),descendants=children.get(id);
    if(!descendants?.length||branches.has(id))continue;
    branches.add(id);
    for(const child of descendants)pending.push(child.id);
  }
  branches.delete(null);
  return branches;
}
export function outlineRows(items,{query='',collapsed=[],filterIds=null}={}){
  const {byId,children}=outlineTree(items),closed=new Set(collapsed),filtering=!!query.trim()||filterIds!==null;
  const matches=new Set(items.filter(item=>(!filterIds||filterIds.has(item.id))&&outlineNameMatches(item,query)).map(item=>item.id)),included=new Set(matches);
  if(filtering)for(const id of matches){let parent=byId.get(id)?.parentId;const visited=new Set([id]);while(byId.has(parent)&&!visited.has(parent)){visited.add(parent);included.add(parent);parent=byId.get(parent).parentId;}}
  const result=[],visited=new Set();
  function visit(item,ancestorGuides,hasNext){
    if(visited.has(item.id)||!included.has(item.id))return;
    visited.add(item.id);
    const descendants=(children.get(item.id)||[]).filter(child=>included.has(child.id)),hasChildren=descendants.length>0;
    const expanded=hasChildren&&(filtering||!closed.has(item.id));
    result.push({item,depth:ancestorGuides.length,ancestorGuides,hasNext,hasChildren,expanded,matched:matches.has(item.id)});
    if(expanded)visitSiblings(descendants,[...ancestorGuides,hasNext]);
  }
  function visitSiblings(siblings,ancestorGuides){
    siblings.forEach((item,index)=>visit(item,ancestorGuides,index<siblings.length-1));
  }
  visitSiblings((children.get(null)||[]).filter(item=>included.has(item.id)),[]);
  return result;
}
