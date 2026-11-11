// Versioned design intent, shared by structured clients and the inspector.
export const RULE_KINDS={visual:'视觉关系',present:'内容保留',above:'图层前后',mask:'蒙版类型',text:'文字内容'};
export const ROLES={artwork:'融合美术',character:'人物',typography:'文字',geometry:'几何',background:'背景',decoration:'点缀',other:'其他'};
export const SOURCE_KINDS={user_request:'用户明确要求',master_reference:'母版特征',ai_inference:'AI 推断'};
export function designOf(doc){return doc.design||{version:1,space:{id:'top',name:'顶视主面',purpose:''},brief:'',masterAssetId:null,policy:'draft',roles:{},assets:{},rules:[],reviews:{}};}
const str=(v,n=2000)=>typeof v==='string'&&v.length<=n;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const key=v=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const choice=(v,values)=>values.includes(v);
function requireValue(ok,message){if(!ok)throw Error(message);}
export function validateDesign(doc){
 if(!doc.design)return;const d=doc.design;
 requireValue(d.version===1&&object(d.space)&&d.space.id==='top'&&str(d.space.name,100)&&d.space.name.trim()&&str(d.space.purpose), '设计空间描述无效');
 requireValue(str(d.brief,6000)&&choice(d.policy,['draft','enforce']),'设计意图摘要或执行策略无效');
 requireValue(d.masterAssetId===null||doc.assets[d.masterAssetId]?.role==='image','视觉母版必须引用项目中的图片素材');
 requireValue(object(d.roles)&&object(d.assets)&&Array.isArray(d.rules)&&d.rules.length<=100&&object(d.reviews),'设计意图结构无效');
 for(const[id,value]of Object.entries(d.roles))requireValue(key(id)&&choice(value,Object.keys(ROLES)),'图层语义角色无效');
 for(const[id,m]of Object.entries(d.assets)){
  requireValue(doc.assets[id]?.role==='image'&&object(m),'素材说明引用无效');
  requireValue(choice(m.kind,['master','character','graphic','background','reference','artwork','other'])&&str(m.notes,4000)&&str(m.generator,200)&&(m.model===null||str(m.model,200))&&str(m.prompt,12000),'素材来源说明无效');
  requireValue(m.derivedFrom===null||(m.derivedFrom!==id&&doc.assets[m.derivedFrom]?.role==='image'),'素材母版来源无效');
  const seen=new Set([id]);let source=m.derivedFrom;while(source){requireValue(!seen.has(source),'素材来源存在循环');seen.add(source);source=d.assets[source]?.derivedFrom;}
 }
 const ids=new Set();
 for(const r of d.rules){
  requireValue(object(r)&&key(r.id)&&!ids.has(r.id)&&str(r.name,300)&&r.name.trim()&&Object.hasOwn(RULE_KINDS,r.kind),'意图条目 ID、名称或类型无效');ids.add(r.id);
  requireValue(choice(r.priority,['must','prefer'])&&object(r.source)&&Object.hasOwn(SOURCE_KINDS,r.source.kind)&&str(r.source.note,2000)&&r.source.note.trim(),'意图优先级或判断来源无效');
  requireValue(Array.isArray(r.targets)&&r.targets.length<=50&&r.targets.every(key)&&new Set(r.targets).size===r.targets.length,'意图目标图层无效');
  requireValue(r.kind!=='above'||r.targets.length===2,'图层前后关系需要两个不同目标，前者应在上');
  requireValue(!['mask','text'].includes(r.kind)||r.targets.length===1,'蒙版和文字条目需要一个目标');
  requireValue(!['present'].includes(r.kind)||r.targets.length>0,'内容保留需要目标图层');
  if(r.kind==='mask')requireValue(choice(r.maskKind,['invert','cutout','clip']),'蒙版意图类型无效');
  if(r.kind==='text')requireValue(str(r.expected,2000)&&r.expected.trim(),'需要保留的完整文字');
 }
 for(const[id,r]of Object.entries(d.reviews))requireValue(key(id)&&object(r)&&choice(r.status,['pass','fail'])&&str(r.note,4000)&&r.note.trim()&&choice(r.reviewer,['ai','operator','user_feedback'])&&/^[a-f0-9]{64}$/.test(r.subjectHash)&&str(r.createdAt,100)&&object(r.evidence),'观察记录无效');
}
export function applyDesignCommand(doc,c){
 doc.design=structuredClone(designOf(doc));const d=doc.design;
 if(c.op==='design.update'){
  requireValue(object(c.patch),'需要设计意图字段');for(const[k,v]of Object.entries(c.patch)){requireValue(['brief','masterAssetId','policy','space'].includes(k),'不可修改设计字段：'+k);if(k==='space')requireValue(object(v)&&Object.keys(v).every(k=>['id','name','purpose'].includes(k)),'坐标和几何绑定不可通过描述修改');d[k]=structuredClone(v);}
 }else if(c.op==='design.rule.put'){
  const i=d.rules.findIndex(r=>r.id===c.rule.id);if(i<0)d.rules.push(structuredClone(c.rule));else d.rules[i]=structuredClone(c.rule);
 }else if(c.op==='design.rule.delete'){requireValue(d.rules.some(r=>r.id===c.id),'意图条目不存在');d.rules=d.rules.filter(r=>r.id!==c.id);delete d.reviews[c.id];
 }else if(c.op==='design.role'){requireValue(doc.layers.some(l=>l.id===c.id),'目标图层不存在');if(c.role===null)delete d.roles[c.id];else d.roles[c.id]=c.role;
 }else if(c.op==='design.asset'){requireValue(doc.assets[c.id]?.role==='image','目标图片不存在');d.assets[c.id]=structuredClone(c.metadata);
 }else if(c.op==='design.review'){
  requireValue(d.rules.some(r=>r.id===c.id&&r.kind==='visual'),'观察记录只适用于视觉关系条目');requireValue(object(c.observation),'观察必须由服务绑定当前设计');d.reviews[c.id]=structuredClone(c.observation);
 }else throw Error('未知设计命令：'+c.op);
}
// Canonical semantic subject: reviews and incidental revision/time do not alter it.
export function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(object(value))return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function designSubject(doc){const d=structuredClone(designOf(doc));delete d.reviews;return canonical({canvas:doc.canvas,layers:doc.layers,assets:doc.assets,fonts:doc.fonts,basecoat:doc.basecoat,source:doc.source,guides:doc.guides,design:d});}
function ancestorsShown(doc,l){return Boolean(l&&l.visible&&l.opacity>0&&(!l.parentId||ancestorsShown(doc,doc.layers.find(p=>p.id===l.parentId))));}
function shown(doc,l){return ancestorsShown(doc,l)&&(l.type!=='group'||doc.layers.filter(c=>c.parentId===l.id).some(c=>shown(doc,c)));}
function paintOrder(doc){const ids=[];function add(l){ids.push(l.id);if(l.type==='group')for(const c of doc.layers.filter(n=>n.parentId===l.id))add(c);}for(const l of doc.layers.filter(n=>!n.parentId))add(l);return ids;}
function ancestor(doc,l,id){while(l?.parentId){if(l.parentId===id)return true;l=doc.layers.find(n=>n.id===l.parentId);}return false;}
export function assessDesign(doc,subjectHash){
 const d=designOf(doc),order=paintOrder(doc),rows=d.rules.map(r=>{
  const targets=r.targets.map(id=>doc.layers.find(l=>l.id===id)),missing=r.targets.filter((id,i)=>!targets[i]);let status='pass',reason='';
  if(r.source.kind==='master_reference'&&!d.masterAssetId){status='fail';reason='条目来自母版特征，但尚未关联视觉母版';}
  else if(missing.length){status='fail';reason='目标图层已删除或不存在：'+missing.join('、');}
  else if(targets.some(l=>!shown(doc,l))){status='fail';reason='目标或父组隐藏、透明，无法保留该内容';}
  else if(r.kind==='visual'){
   const observation=Object.hasOwn(d.reviews,r.id)?d.reviews[r.id]:null;status=!observation?'pending':observation.subjectHash!==subjectHash?'stale':observation.status;
   reason=status==='pending'?'需要针对当前设计记录视觉观察':status==='stale'?'设计、素材或意图已变化，旧观察不适用于当前内容':observation.note;
  }else if(r.kind==='above'){
   if(ancestor(doc,targets[0],targets[1].id)||ancestor(doc,targets[1],targets[0].id)){status='fail';reason='父子组不能用作独立前后关系';}
   else if(order.indexOf(targets[0].id)<=order.indexOf(targets[1].id)){status='fail';reason='前一个目标没有排在后一个目标上方';}else reason='绘制顺序符合前后关系；未判断是否实际重叠';
  }else if(r.kind==='mask'){
   if(targets[0].mask?.kind!==r.maskKind){status='fail';reason='目标缺少要求的蒙版类型';}else reason='目标的蒙版类型符合；实际作用范围与视觉效果仍需观察';
  }else if(r.kind==='text'){
   if(targets[0].type!=='text'||targets[0].text!==r.expected){status='fail';reason='文字内容已改变或目标不是可编辑文字';}else reason='完整文字内容一致；表面占地由几何任务另行检查';
  }else reason='目标存在且显示；未验证图片内部语义或透明像素';
  return {...r,status,reason,observation:Object.hasOwn(d.reviews,r.id)?d.reviews[r.id]:null};
 });
 const blocking=rows.filter(r=>r.priority==='must'&&r.status!=='pass');
 return {revision:doc.revision,subjectHash,policy:d.policy,rows,pass:rows.length>0&&blocking.length===0,ready:d.policy==='draft'||(rows.length>0&&blocking.length===0),blocking: blocking.map(r=>r.id),pending:rows.filter(r=>['pending','stale'].includes(r.status)).length,limits:['结构检查不等于视觉质量判断。','视觉观察仅对应其内容指纹，不代表用户最终验收。','当前只有一个可编辑主 VDS；独立垂尾沿用关联图案。']};
}
