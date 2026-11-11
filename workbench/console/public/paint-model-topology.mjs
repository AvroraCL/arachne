export async function loadModelTopology(projectId,signal){
  const url='/api/projects/'+projectId+'/viewport/topology';
  async function request(path,options={}){
    const response=await fetch(path,{...options,signal});
    if(!response.ok)throw Error('无法读取原拓扑');
    return response.json();
  }
  let state=await request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  while(state.status==='running'){
    await new Promise(resolve=>setTimeout(resolve,350));
    state=await request(url);
  }
  if(state.status!=='ready')throw Error(state.error||'无法读取原拓扑');
  return request(state.url);
}

function edgeKey(a,b){return a<b?a+':'+b:b+':'+a;}

export function primitiveTopology(geometry,data){
  const position=geometry.attributes.position;
  if(!Array.isArray(data?.vertices)||data.vertices.length!==position.count)return null;
  const vertices=data.vertices;
  const aliases=new Map();
  for(let i=0;i<vertices.length;i++){
    const id=vertices[i];
    if(id<0)continue;
    if(!aliases.has(id))aliases.set(id,[]);
    aliases.get(id).push(i);
  }
  const topology={vertices,aliases};
  const polygonIds=data.polygons,index=geometry.index;
  if(polygonIds?.length!==(index?.count??position.count)/3)return topology;
  const faces=new Map();
  for(let face=0;face<polygonIds.length;face++){
    const id=polygonIds[face];
    let group=faces.get(id);
    if(!group){
      group={triangles:[],vertices:new Map(),edgeCounts:new Map()};
      faces.set(id,group);
    }
    const start=face*3;
    const triangle=index?[index.getX(start),index.getX(start+1),index.getX(start+2)]:[start,start+1,start+2];
    group.triangles.push(...triangle);
    for(let i=0;i<3;i++){
      const a=triangle[i],b=triangle[(i+1)%3],left=vertices[a],right=vertices[b];
      group.vertices.set(left,a);
      const key=edgeKey(left,right);
      const edge=group.edgeCounts.get(key);
      if(edge)edge.count++;
      else group.edgeCounts.set(key,{count:1,pair:[a,b]});
    }
  }
  const allEdges=new Map();
  for(const [id,{triangles,vertices:groupVertices,edgeCounts}] of faces){
    const edges=[];
    for(const [key,{count,pair}] of edgeCounts){
      if(count===1){edges.push(pair);allEdges.set(key,pair);}
    }
    faces.set(id,{triangles,vertices:[...groupVertices.values()],edges});
  }
  return {...topology,polygonIds,faces,edgeIndices:[...allEdges.values()].flat()};
}

export function mergePrimitiveAliases(primitives){
  const aliases=new Map();
  for(const {mesh,topology} of primitives){
    for(const [id,indices] of topology.aliases){
      if(!aliases.has(id))aliases.set(id,[]);
      aliases.get(id).push({mesh,indices});
    }
  }
  return aliases;
}
