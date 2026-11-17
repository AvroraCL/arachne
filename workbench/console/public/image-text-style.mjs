export const textFonts={
  sourceHan:{label:'思源黑体',family:'"Source Han Sans SC"',paths:['SourceHanSansSC-VF.ttf'],
    weights:[[250,'特细'],[300,'细'],[350,'标准'],[400,'常规'],[500,'中等'],[700,'粗体'],[900,'特粗']]},
  plexMono:{label:'IBM Plex Mono',family:'"IBM Plex Mono", "Source Han Sans SC"',weights:[[400,'常规'],[700,'粗体']],paths:[
    'fonts/ibm-plex-mono/IBMPlexMono-Regular.ttf','fonts/ibm-plex-mono/IBMPlexMono-Bold.ttf']}
};
export const textDefaults={content:'',fontSize:128,weight:700,align:'left',color:'#e6e3d7',
  font:'sourceHan',tracking:0,leading:0};
export const textEffects={
  outline:{label:'描边',fields:{color:{label:'描边颜色',value:'#15171a'},width:{label:'宽度',value:6,min:1,max:96}}},
  shadow:{label:'投影',fields:{color:{label:'投影颜色',value:'#000000'},opacity:{label:'投影不透明度',value:65,min:0,max:100},
    x:{label:'偏移 X',value:10,min:-256,max:256},y:{label:'偏移 Y',value:12,min:-256,max:256},blur:{label:'模糊',value:8,min:0,max:96}}},
  overlay:{label:'颜色叠加',fields:{color:{label:'叠加颜色',value:'#f4d477'}}},
  gradient:{label:'渐变叠加',fields:{start:{label:'起点颜色',value:'#ffffff'},end:{label:'终点颜色',value:'#ec672c'},angle:{label:'渐变角度',value:90,min:-180,max:180}}}
};

export const imageStyleKinds=['image','pixel','shape','group'];
export const outlinePositions=[['inside','内侧'],['center','居中'],['outside','外侧']];
export const hasImageStyle=layer=>Object.values(layer.styles??{}).some(style=>style.enabled);

export function checkStyleFields(id,settings,extra=[]){
  const specs=textEffects[id]?.fields;
  if(!Object.hasOwn(textEffects,id)||!settings||typeof settings!=='object'||Array.isArray(settings)||
     Object.keys(settings).some(key=>!Object.hasOwn(specs,key)&&!extra.includes(key)))throw Error('图层样式参数无效');
  for(const [key,{value,min,max}] of Object.entries(specs)){
    const actual=settings[key];
    if(typeof value==='string'?typeof actual!=='string'||!/^#[a-f0-9]{6}$/i.test(actual):
      !Number.isInteger(actual)||actual<min||actual>max)throw Error('图层样式参数无效');
  }
}

export function checkImageStyles(layer){
  const styles=layer.styles;
  if(!imageStyleKinds.includes(layer.kind)||!styles||typeof styles!=='object'||Array.isArray(styles))
    throw Error('此图层不支持图层样式');
  for(const [id,settings] of Object.entries(styles)){
    checkStyleFields(id,settings,id==='outline'?['enabled','position']:['enabled']);
    if(typeof settings.enabled!=='boolean'||id==='outline'&&!outlinePositions.some(([key])=>key===settings.position))
      throw Error('图层样式参数无效');
  }
}

// Offset of the paragraph origin inside the rendered PNG, including effects.
export function paragraphOrigin(style){
  const {outline,shadow}=style.effects??{};
  const margin=(outline?.width??0)+2;
  return ['x','y'].map(axis=>margin+(shadow?Math.max(0,shadow.blur*3-shadow[axis]):0));
}

const fontLoads=new Map();
const projectFamily=id=>'ArachneFont-'+id;

export function loadProjectFont(project,id,entry){
  if(Object.hasOwn(textFonts,id))return Promise.resolve();
  if(!entry)return Promise.reject(Error('工程中没有该字体，请重新添加原字体文件'));
  const url='/api/projects/'+encodeURIComponent(project)+'/paint/fonts/'+encodeURIComponent(id);
  if(!fontLoads.has(url)){
    const weights=entry.weights.map(([weight])=>weight);
    const descriptor=weights.length===1?String(weights[0]):Math.min(...weights)+' '+Math.max(...weights);
    const promise=new FontFace(projectFamily(id),`url("${url}")`,{weight:descriptor,style:entry.italic?'italic':'normal'}).load()
      .then(face=>{document.fonts.add(face);})
      .catch(()=>{
        fontLoads.delete(url);
        throw Error('无法加载字体 '+entry.family+' · '+entry.style+'，请重新添加原字体文件');
      });
    fontLoads.set(url,promise);
  }
  return fontLoads.get(url);
}

export function textPreviewStyle(style,scale=1,fonts={}){
  const {outline,shadow,overlay,gradient}=style.effects??{};
  return {fontFamily:textFonts[style.font]?.family??projectFamily(style.font),
    fontStyle:fonts[style.font]?.italic?'italic':'normal',fontOpticalSizing:'none',fontSynthesis:'none',fontSize:style.fontSize*scale+'px',fontWeight:style.weight,
    lineHeight:(style.leading||Math.round(style.fontSize*1.25))*scale+'px',letterSpacing:style.tracking*scale+'px',
    textAlign:style.align,color:overlay?.color??style.color,
    webkitTextStroke:outline?`${outline.width*scale}px ${outline.color}`:'',
    textShadow:shadow?`${shadow.x*scale}px ${shadow.y*scale}px ${shadow.blur*scale}px ${shadow.color}${Math.round(shadow.opacity*2.55).toString(16).padStart(2,'0')}`:'',
    ...(gradient?{backgroundImage:`linear-gradient(${gradient.angle+90}deg,${gradient.start},${gradient.end})`,
      backgroundClip:'text',color:'transparent'}:{backgroundImage:'',backgroundClip:''})};
}
