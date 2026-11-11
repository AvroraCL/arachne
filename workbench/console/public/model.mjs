// Shared document and command model: UI, HTTP clients and renderer use this module.
import {applyDesignCommand,validateDesign} from './design.mjs';
export const clone = value => structuredClone(value);
export const uid = () => globalThis.crypto.randomUUID();
export const TYPES = ['image','text','rect','polygon','path','group'];
const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6;
function simplePolygon(points){
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a,b,p)=>Math.abs(cross(a,b,p))<1e-12&&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]);
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];if(a[0]===b[0]&&a[1]===b[1])return false;
    for(let j=i+1;j<points.length;j++){
      if(j===i+1||(i===0&&j===points.length-1))continue;
      const c=points[j],d=points[(j+1)%points.length];
      if((cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))return false;
    }
  }
  return true;
}
export const defaults = type => ({id:uid(), name:({image:'图片',text:'文字',rect:'色块',polygon:'多边形',path:'路径',group:'分组'})[type],
  type, x:0,y:0,width:500,height:200,rotation:0,scaleX:1,scaleY:1,opacity:1,visible:true,locked:false,parentId:null,
  fill:'#eeeae1',stroke:'#ffffff',strokeWidth:0,...(type==='text'?{text:'Arachne',fontId:'arial',fontSize:140,plate:false}:{}),
  ...(type==='path'?{d:'M 0 200 L 250 0 L 500 200 Z'}:{}),...(type==='polygon'?{points:[[0,200],[250,0],[500,200]]}:{})});

export function validate(doc) {
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.layers) || doc.layers.length > 500) throw Error('项目版本或图层数量无效');
  if (![doc.canvas.width,doc.canvas.height].every(n=>Number.isInteger(n)&&n>=256&&n<=8192)) throw Error('画布尺寸无效');
  const ids = new Set();
  for (const l of doc.layers) {
    if (!/^[\w-]{1,100}$/.test(l.id) || ids.has(l.id) || !TYPES.includes(l.type)) throw Error('图层ID或类型无效');
    ids.add(l.id);
    if (typeof l.name!=='string' || l.name.length>200) throw Error('图层名称无效');
    for (const k of ['x','y','width','height','rotation','scaleX','scaleY','opacity','strokeWidth']) if (!finite(l[k])) throw Error(`图层 ${l.name} 的 ${k} 无效`);
    if (l.width<=0 || l.height<=0 || l.scaleX===0 || l.scaleY===0 || l.opacity<0 || l.opacity>1 || l.strokeWidth<0 || l.strokeWidth>1024) throw Error('图层尺寸/透明度无效');
    if(typeof l.visible!=='boolean'||typeof l.locked!=='boolean'||(l.parentId!==null&&typeof l.parentId!=='string'))throw Error('图层状态无效');
    if(![l.fill,l.stroke].every(c=>typeof c==='string'&&(/^(#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|none|transparent)$/i.test(c))))throw Error('只支持明确的十六进制颜色或none');
    if (l.type==='image' && !Object.hasOwn(doc.assets,l.assetId)) throw Error('图片素材不存在');
    if (l.type==='text' && (!Object.hasOwn(doc.fonts,l.fontId) || typeof l.text!=='string' || l.text.length>2000 || !finite(l.fontSize) || l.fontSize<=0)) throw Error('文字或字体无效');
    for(const k of ['shapeWidth','shapeHeight'])if(l[k]!==undefined&&(!finite(l[k])||l[k]<=0))throw Error('形状原始尺寸无效');
    if(l.surfaceRegions!==undefined){
      if(l.type==='group'||!Array.isArray(l.surfaceRegions)||l.surfaceRegions.length>32)throw Error('关键区域须属于具体图层，最多32个');
      const regionIds=new Set();
      for(const r of l.surfaceRegions){
        if(!r||typeof r.id!=='string'||!/^[\w-]{1,100}$/.test(r.id)||regionIds.has(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>100)throw Error('关键区域ID或名称无效');
        regionIds.add(r.id);
        const unit=n=>finite(n)&&n>=0&&n<=1;
        if(r.points!==undefined){
          if(r.box!==undefined||!Array.isArray(r.points)||r.points.length<3||r.points.length>100||!r.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(unit)))throw Error('关键区域多边形无效');
          const area=Math.abs(r.points.reduce((sum,p,i)=>{const q=r.points[(i+1)%r.points.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
          if(area<1e-8)throw Error('关键区域多边形面积无效');
          if(!simplePolygon(r.points))throw Error('关键区域多边形不能自交或重复顶点');
        }else if(!Array.isArray(r.box)||r.box.length!==4||!r.box.every(unit)||r.box[0]>=r.box[2]||r.box[1]>=r.box[3])throw Error('关键区域范围须为图层内有效的归一化矩形');
      }
    }
    if (l.type==='path' && (typeof l.d!=='string' || !/^[MmLlHhVvCcSsQqTtAaZz\d\s.,+eE-]*$/.test(l.d) || l.d.length>30000)) throw Error('路径无效');
    if (l.type==='polygon' && (!Array.isArray(l.points) || l.points.length<3 || l.points.length>2000 || !l.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(finite)))) throw Error('多边形无效');
    if (l.mask) {
      const m=l.mask;
      if (!['clip','cutout','invert'].includes(m.kind) || !['rect','polygon'].includes(m.type)) throw Error('蒙版类型无效');
      if (m.type==='rect' && (![m.x,m.y,m.width,m.height].every(finite) || m.width<=0 || m.height<=0)) throw Error('蒙版矩形无效');
      if (m.type==='polygon' && (!Array.isArray(m.points)||m.points.length<3||!m.points.every(p=>p.length===2&&p.every(finite)))) throw Error('蒙版多边形无效');
    }
  }
  for(const l of doc.layers){
    const seen=new Set([l.id]);let p=l.parentId;
    while(p){const parent=doc.layers.find(x=>x.id===p);if(!parent||parent.type!=='group'||seen.has(p))throw Error('图层分组存在循环或父组无效');seen.add(p);p=parent.parentId;}
  }
  validateDesign(doc);return doc;
}

const EDITABLE = new Set(['name','x','y','width','height','rotation','scaleX','scaleY','opacity','visible','locked','fill','stroke','strokeWidth','text','fontId','fontSize','plate','d','points','assetId','mask','surfaceRegions']);
export function applyCommands(original, commands) {
  if(!Array.isArray(commands)||!commands.length||commands.length>200)throw Error('需要1–200条编辑命令');
  const doc=clone(original);
  const find=id=>{const l=doc.layers.find(l=>l.id===id);if(!l)throw Error(`图层不存在：${id}`);return l;};
  const locked=l=>{let n=l;while(n){if(n.locked)return true;n=doc.layers.find(p=>p.id===n.parentId);}return false;};
  for(const c of commands){
    if(c.op.startsWith('design.'))applyDesignCommand(doc,c);
    else if(c.op==='create') {const l={...defaults(c.layer.type),...clone(c.layer)};if(['path','polygon'].includes(l.type)){l.shapeWidth??=l.width;l.shapeHeight??=l.height;}doc.layers.push(l);if(l.parentId&&locked(find(l.parentId)))throw Error('父组已锁定');}
    else if(c.op==='update'){const l=find(c.id);if(locked(l)&&Object.keys(c.patch).some(k=>k!=='locked'))throw Error('图层或父组已锁定');for(const[k,v]of Object.entries(c.patch)){if(!EDITABLE.has(k))throw Error(`不可修改字段：${k}`);l[k]=clone(v);}}
    else if(c.op==='delete'){const l=find(c.id);if(locked(l))throw Error('图层已锁定');const ids=new Set([l.id]);let size;do{size=ids.size;for(const n of doc.layers)if(ids.has(n.parentId))ids.add(n.id);}while(ids.size!==size);doc.layers=doc.layers.filter(n=>!ids.has(n.id));}
    else if(c.op==='reorder'){const l=find(c.id);if(locked(l))throw Error('图层已锁定');const old=doc.layers.indexOf(l);doc.layers.splice(old,1);doc.layers.splice(Math.max(0,Math.min(doc.layers.length,c.index)),0,l);}
    else if(c.op==='group'){const children=c.ids.map(find);if(!children.length||children.some(locked)||new Set(children.map(l=>l.parentId)).size!==1)throw Error('请选择同组中未锁定的图层');const g={...defaults('group'),id:c.id||uid(),name:c.name||'分组',parentId:children[0].parentId};doc.layers.push(g);for(const l of children)l.parentId=g.id;}
    else if(c.op==='mask'){const l=find(c.id);if(locked(l))throw Error('图层已锁定');l.mask=clone(c.mask);}
    else if(c.op==='basecoat'){if(!/^#[\da-f]{6}$/i.test(c.color)||typeof c.reason!=='string'||!c.reason.trim())throw Error('需要底色和选色理由');doc.basecoat={color:c.color,reason:c.reason};}
    else throw Error(`未知命令：${c.op}`);
  }
  return validate(doc);
}
export const identity = [1,0,0,1,0,0];
export function multiply(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
export function localMatrix(l){const r=l.rotation*Math.PI/180,c=Math.cos(r),s=Math.sin(r);return [c*l.scaleX,s*l.scaleX,-s*l.scaleY,c*l.scaleY,l.x,l.y];}
export function worldMatrix(doc,l){return l.parentId?multiply(worldMatrix(doc,doc.layers.find(n=>n.id===l.parentId)),localMatrix(l)):localMatrix(l);}
export const point=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
export function visible(doc,l){return l.visible&&l.opacity>0&&(!l.parentId||visible(doc,doc.layers.find(n=>n.id===l.parentId)));}
export function textFootprints(doc){return doc.layers.filter(l=>l.type==='text'&&visible(doc,l)).map(l=>{
  const m=worldMatrix(doc,l),pad=l.strokeWidth/2+2;
  const p=[[-pad,-pad],[l.width+pad,-pad],[l.width+pad,l.height+pad],[-pad,l.height+pad]].map(([x,y])=>point(m,x,y));
  return {id:l.id,name:l.name,fontId:l.fontId,box:[Math.min(...p.map(p=>p[0]))/doc.canvas.width,Math.min(...p.map(p=>p[1]))/doc.canvas.height,Math.max(...p.map(p=>p[0]))/doc.canvas.width,Math.max(...p.map(p=>p[1]))/doc.canvas.height]};
});}

// Explicit regions are relative to the layer box. They follow resizing and all ancestor transforms.
// Masks never reduce this conservative rectangle: users protect a feature, not just its surviving ink.
export function surfaceFootprints(doc){
  const footprints=textFootprints(doc).map(r=>({...r,regionId:'text',kind:'text'}));
  for(const l of doc.layers.filter(l=>visible(doc,l)))for(const r of l.surfaceRegions||[]){
    const m=worldMatrix(doc,l),[x0,y0,x1,y1]=r.box||[0,0,1,1];
    const shapeScale=['path','polygon'].includes(l.type)?Math.max(l.width/(l.shapeWidth||l.width),l.height/(l.shapeHeight||l.height)):1;
    const pad=2+l.strokeWidth*shapeScale/2;
    const corners=(r.points?r.points.map(([x,y])=>[x*l.width,y*l.height]):[[x0*l.width-pad,y0*l.height-pad],[x1*l.width+pad,y0*l.height-pad],[x1*l.width+pad,y1*l.height+pad],[x0*l.width-pad,y1*l.height+pad]]).map(([x,y])=>point(m,x,y));
    const normalized=corners.map(([x,y])=>[x/doc.canvas.width,y/doc.canvas.height]);
    const margin=r.points?pad*Math.max(Math.hypot(m[0],m[2])/doc.canvas.width,Math.hypot(m[1],m[3])/doc.canvas.height):0;
    footprints.push({id:l.id,regionId:r.id,name:l.name+' · '+r.name,kind:'region',...(r.points?{points:normalized,margin}:{}),
      box:[Math.min(...normalized.map(p=>p[0]))-margin,Math.min(...normalized.map(p=>p[1]))-margin,Math.max(...normalized.map(p=>p[0]))+margin,Math.max(...normalized.map(p=>p[1]))+margin]});
  }
  return footprints;
}
export const unassignedSurfaceLayers=doc=>doc.layers.filter(l=>visible(doc,l)&&!['text','group'].includes(l.type)&&!l.surfaceRegions?.length).map(l=>({id:l.id,name:l.name,type:l.type}));
