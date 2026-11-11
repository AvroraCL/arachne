export const renderOpticsFields=Object.freeze({
  focusDistance:[.001,1e6],fStop:[.1,64],blades:[0,16],rotation:[-180,180],ratio:[.1,10]
});
export const renderOpticsDefaults=Object.freeze({
  enabled:true,focusMode:'target',focusDistance:10,fStop:2.8,blades:0,rotation:0,ratio:1
});

export function checkRenderOptics(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==Object.keys(renderOpticsDefaults).length||
    typeof value.enabled!=='boolean'||!['target','distance'].includes(value.focusMode))
    throw Error('相机景深设置无效');
  const result={enabled:value.enabled,focusMode:value.focusMode};
  for(const [key,[min,max]] of Object.entries(renderOpticsFields)){
    const n=value[key];
    if(!Object.hasOwn(value,key)||typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||
      (key==='blades'&&(!Number.isInteger(n)||n!==0&&n<3)))throw Error('相机景深数值无效');
    result[key]=n;
  }
  return result;
}

export function matchesRenderOptics(expected,actual){
  if(!expected)return actual==null;
  if(!actual||actual.enabled!==expected.enabled||actual.focusMode!==expected.focusMode)return false;
  const near=(x,y)=>Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<1e-5*Math.max(1,Math.abs(y));
  const focus=expected.focusMode==='target'?actual.targetDistance:expected.focusDistance;
  return focus>0&&near(actual.focusDistance,focus)&&
    ['fStop','blades','rotation','ratio'].every(key=>near(actual[key],expected[key]));
}
