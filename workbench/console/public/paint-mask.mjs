export function createMaskEditor(save){
  const $=id=>document.getElementById(id);
  const dialog=$('mask-editor'),canvas=$('mask-canvas');
  const ctx=canvas.getContext('2d',{alpha:false});
  const tileSize=128,historyLimit=64*1024*1024;
  let undo=[],redo=[],pending=null,historyBytes=0;
  let session=null,stroke=null,ink=0,saving=false,surface=null,surfaceStroke=null;
  function historyControls(){
    $('mask-undo').disabled=!undo.length||!!pending||saving;
    $('mask-redo').disabled=!redo.length||!!pending||saving;
  }
  function beginEdit(){pending=new Map();historyControls();}
  function capture(x,y,w,h){
    const rgba=ctx.getImageData(x,y,w,h).data,pixels=new Uint8Array(w*h);
    for(let i=0;i<pixels.length;i++)pixels[i]=rgba[i*4];
    return {x,y,w,h,pixels};
  }
  function remember(left,top,right,bottom){
    if(!pending)return;
    for(let y=Math.floor(Math.max(0,top)/tileSize)*tileSize;y<Math.min(bottom,canvas.height);y+=tileSize){
      for(let x=Math.floor(Math.max(0,left)/tileSize)*tileSize;x<Math.min(right,canvas.width);x+=tileSize){
        const key=y*canvas.width+x;
        if(!pending.has(key))pending.set(key,capture(x,y,Math.min(tileSize,canvas.width-x),Math.min(tileSize,canvas.height-y)));
      }
    }
  }
  function finishEdit(){
    if(pending?.size){
      const tiles=[...pending.values()],bytes=tiles.reduce((total,tile)=>total+tile.pixels.length,0);
      historyBytes-=redo.reduce((total,entry)=>total+entry.bytes,0);redo=[];
      undo.push({tiles,bytes});historyBytes+=bytes;
      while(historyBytes>historyLimit&&undo.length>1)historyBytes-=undo.shift().bytes;
    }
    pending=null;historyControls();
  }
  function travel(from,to){
    if(saving||pending||!from.length)return;
    const entry=from.pop();
    const inverse=entry.tiles.map(({x,y,w,h,pixels})=>{
      const previous=capture(x,y,w,h);
      const image=ctx.createImageData(w,h);
      for(let i=0;i<pixels.length;i++){
        const offset=i*4;
        image.data[offset]=image.data[offset+1]=image.data[offset+2]=pixels[i];
        image.data[offset+3]=255;
      }
      ctx.putImageData(image,x,y);
      return previous;
    });
    to.push({tiles:inverse,bytes:entry.bytes});
    surface?.preview(canvas);historyControls();
  }
  function fill(value){
    remember(0,0,canvas.width,canvas.height);
    ctx.fillStyle=value;ctx.fillRect(0,0,canvas.width,canvas.height);surface?.preview(canvas);
  }
  function selectInk(value){
    ink=value;
    $('mask-hide').setAttribute('aria-pressed',String(!value));
    $('mask-reveal').setAttribute('aria-pressed',String(!!value));
  }
  function dab(x,y,r){
    remember(x-r-1,y-r-1,x+r+1,y+r+1);
    const hardness=Number($('mask-hardness').value)/100;
    const value=`rgb(${ink},${ink},${ink})`;
    if(hardness===1)ctx.fillStyle=value;
    else{
      const gradient=ctx.createRadialGradient(x,y,r*hardness,x,y,r);
      gradient.addColorStop(0,value);
      gradient.addColorStop(1,`rgba(${ink},${ink},${ink},0)`);
      ctx.fillStyle=gradient;
    }
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  }
  function point(event){
    const rect=canvas.getBoundingClientRect();
    return {x:(event.clientX-rect.left)*canvas.width/rect.width,
      y:(event.clientY-rect.top)*canvas.height/rect.height};
  }
  const radius=()=>Math.min(canvas.width,canvas.height)*Number($('mask-size').value)/200;
  canvas.onpointerdown=event=>{
    if(event.button!==0||saving||pending)return;
    beginEdit();
    canvas.setPointerCapture(event.pointerId);
    const p=point(event);
    stroke={...p,id:event.pointerId};dab(p.x,p.y,radius());
  };
  canvas.onpointermove=event=>{
    if(stroke?.id!==event.pointerId)return;
    const p=point(event),r=radius();
    const dx=p.x-stroke.x,dy=p.y-stroke.y;
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/Math.max(1,r*.22)));
    for(let i=1;i<=steps;i++)dab(stroke.x+dx*i/steps,stroke.y+dy*i/steps,r);
    stroke={...p,id:event.pointerId};
  };
  canvas.onpointerup=canvas.onpointercancel=canvas.onlostpointercapture=event=>{
    if(stroke?.id!==event.pointerId)return;
    stroke=null;finishEdit();
  };
  dialog.addEventListener('close',()=>{
    surface?.close();surface=null;surfaceStroke=null;stroke=null;pending=null;undo=[];redo=[];historyBytes=0;dialog.classList.remove('surface-mask');
  });
  function surfaceDab(x,y){
    const hit=surface.pick(x,y);
    if(!hit||hit.u<0||hit.u>1||hit.v<0||hit.v>1)return;
    ctx.save();ctx.beginPath();
    hit.triangle.forEach(([u,v],i)=>ctx[i?'lineTo':'moveTo'](u*canvas.width,v*canvas.height));
    ctx.closePath();ctx.clip();
    dab(hit.u*canvas.width,hit.v*canvas.height,radius());
    ctx.restore();
  }
  function surfacePointer(event){
    if(!surface||saving||!dialog.open)return;
    const {pointerId:id,clientX:x,clientY:y}=event;
    if(event.type==='pointerdown'){
      if(event.button!==0||event.altKey||!event.target.matches('canvas')||pending)return;
      beginEdit();surfaceStroke={id,x,y};event.target.setPointerCapture(id);
      surfaceDab(x,y);
    }else{
      if(surfaceStroke?.id!==id)return;
      if(event.type==='pointermove'){
        const from=surfaceStroke,dx=x-from.x,dy=y-from.y;
        const steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/6));
        for(let i=1;i<=steps;i++)surfaceDab(from.x+dx*i/steps,from.y+dy*i/steps);
        surfaceStroke={id,x,y};
      }else{surfaceStroke=null;finishEdit();}
    }
    event.preventDefault();event.stopImmediatePropagation();surface.preview(canvas);
  }
  $('mask-hide').onclick=()=>selectInk(0);
  $('mask-reveal').onclick=()=>selectInk(255);
  function fillEdit(value){if(!saving&&!pending){beginEdit();fill(value);finishEdit();}}
  $('mask-white').onclick=()=>fillEdit('#fff');
  $('mask-black').onclick=()=>fillEdit('#000');
  $('mask-undo').onclick=()=>travel(undo,redo);
  $('mask-redo').onclick=()=>travel(redo,undo);
  $('mask-close').onclick=()=>{if(!saving)dialog.close();};
  dialog.oncancel=event=>{if(saving)event.preventDefault();};
  document.addEventListener('keydown',event=>{
    if(dialog.open&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){
      event.preventDefault();if(event.shiftKey)travel(redo,undo);else travel(undo,redo);
    }
    if(event.key==='Escape'&&surface&&dialog.open&&!saving){
      event.preventDefault();dialog.close();
    }
  });
  $('mask-save').onclick=async()=>{
    if(saving||pending||!session)return;
    saving=true;$('mask-save').disabled=true;historyControls();
    $('mask-status').textContent='正在保存';
    try{
      const data=canvas.toDataURL('image/png').split(',')[1];
      await save({...session,data});
      dialog.close();
    }catch(error){$('mask-status').textContent=error.message;}
    finally{saving=false;$('mask-save').disabled=false;historyControls();}
  };
  return {surfacePointer,isOpen:()=>dialog.open,async open({projectId,revision,layer,source,surfaceControls}){
    let image;
    if(source){image=new Image();image.src=source;await image.decode();}
    canvas.width=image?.naturalWidth||1024;canvas.height=image?.naturalHeight||1024;
    canvas.style.aspectRatio=canvas.width+' / '+canvas.height;
    const base=Math.round((layer.maskBase??1)*255);
    fill(`rgb(${base},${base},${base})`);
    if(image){
      ctx.filter='grayscale(1)';ctx.drawImage(image,0,0);ctx.filter='none';
    }
    session={projectId,revision,layerId:layer.id,name:layer.name+' · 手绘蒙版'};
    stroke=null;selectInk(0);historyControls();
    $('mask-title').textContent=layer.name+' · 蒙版';
    $('mask-space').textContent=layer.kind==='decal'&&!layer.projector?'贴花坐标':'UV 坐标';
    $('mask-status').textContent='黑色遮盖 · 白色恢复';
    surface=surfaceControls||null;
    if(surface){
      dialog.classList.add('surface-mask');
      $('mask-status').textContent='在机体表面绘制 · 黑色遮盖，白色恢复';
      surface.preview(canvas);
      dialog.show();
    }else dialog.showModal();
  }};
}
