// Editable knots use normalized positions and sRGB swatches. The ramp itself
// interpolates in linear RGB, as does the compositor.
function midpointColor(a,b,t){
  const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
  const encoded=x=>x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055;
  let color='#';
  for(const offset of [1,3,5]){
    const first=linear(parseInt(a.slice(offset,offset+2),16)/255);
    const last=linear(parseInt(b.slice(offset,offset+2),16)/255);
    color+=Math.round(encoded(first+(last-first)*t)*255).toString(16).padStart(2,'0');
  }
  return color;
}
export function materialRampEditor(params,change){
  const editor=document.createElement('div');
  editor.className='shader-ramp-editor';
  editor.innerHTML='<div class="shader-ramp-bar" aria-label="渐变预览"></div><div class="shader-ramp-stops"></div><button type="button" class="shader-ramp-add">添加色标</button>';
  const bar=editor.querySelector('.shader-ramp-bar'),rows=editor.querySelector('.shader-ramp-stops');
  const original=[{position:0,color:params.low},...(params.stops??[]),{position:1,color:params.high}];
  const sorted=stops=>[...stops].sort((a,b)=>a.position-b.position);
  function preview(stops){
    const colors=sorted(stops).map(stop=>stop.color+' '+(stop.position*100)+'%');
    bar.style.backgroundImage='linear-gradient(to right in srgb-linear,'+colors.join(',')+')';
  }
  function apply(stops,save){
    const sequence=sorted(stops);
    preview(sequence);
    change({low:sequence[0].color,high:sequence.at(-1).color,stops:sequence.slice(1,-1)},save);
  }
  function addBetween(a,b){
    const position=(a.position+b.position)/2;
    if(position===a.position||position===b.position)return;
    apply([...original,{position,color:midpointColor(a.color,b.color,.5)}],true);
  }
  editor.querySelector('.shader-ramp-add').onclick=()=>{
    let gap=0;
    for(let i=1;i<original.length-1;i++){
      if(original[i+1].position-original[i].position>original[gap+1].position-original[gap].position)gap=i;
    }
    addBetween(original[gap],original[gap+1]);
  };
  original.forEach((stop,index)=>{
    const row=document.createElement('div'),swatch=document.createElement('input');
    swatch.type='color';swatch.value=stop.color;
    const name=index===0?'起点':index===original.length-1?'终点':'色标 '+index;
    swatch.setAttribute('aria-label',name+' 颜色');swatch.title=name+' 颜色';
    row.append(swatch);
    const set=(field,value,save)=>apply(original.map((item,i)=>i===index?{...item,[field]:value}:item),save);
    swatch.oninput=()=>set('color',swatch.value,false);
    swatch.onchange=()=>set('color',swatch.value,true);
    if(index===0||index===original.length-1){
      const label=document.createElement('span');label.textContent=name+' · '+(stop.position*100)+'%';row.append(label);
    }else{
      const pos=document.createElement('input');pos.type='number';pos.step='any';
      pos.setAttribute('aria-label',name+' 位置（%）');pos.title='色标位置（%）';pos.value=String(stop.position*100);
      const update=save=>{
        const value=pos.valueAsNumber/100;
        const valid=value>0&&value<1&&!original.some((other,i)=>i!==index&&other.position===value);
        pos.setCustomValidity(valid?'':'位置须在 0% 和 100% 之间，且不能与其他色标重合');
        if(valid)set('position',value,save);
        else if(save){
          pos.reportValidity();pos.value=String(stop.position*100);pos.setCustomValidity('');apply(original,false);
        }
      };
      pos.oninput=()=>update(false);pos.onchange=()=>update(true);
      const unit=document.createElement('span');unit.textContent='%';
      const remove=document.createElement('button');remove.type='button';remove.textContent='−';
      remove.title='移除'+name;remove.setAttribute('aria-label',remove.title);
      remove.onclick=()=>apply(original.filter((_,i)=>i!==index),true);
      row.append(pos,unit,remove);
    }
    rows.append(row);
  });
  preview(original);
  return editor;
}
