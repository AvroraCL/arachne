import {outputProfileMode} from './image-output-profile.mjs';
import {fillWorkingSpaces} from './image-color-spaces.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {clipboardImageLimit,clipboardPngSize} from './image-clipboard.mjs';

export const brushImageTypes='image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
export const drawingImageTypes=brushImageTypes+',image/tiff,.tif,.tiff';
const maxBytes=clipboardImageLimit,maxSide=8192;
const supportedTypes=new Set(['image/png','image/jpeg','image/webp','image/tiff','image/x-tiff']);
const pngSignature=[137,80,78,71,13,10,26,10];
const matches=(bytes,offset,signature)=>signature.every((value,index)=>bytes[offset+index]===value);
const ascii=(bytes,offset,length)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
const validSize=([width,height])=>width>0&&height>0&&width<=maxSide&&height<=maxSide;

export function acceptsDrawingImage(file){
  return !!file&&(supportedTypes.has(file.type)||
    (!file.type||file.type==='application/octet-stream')&&/\.(png|jpe?g|webp|tiff?)$/i.test(file.name));
}

function jpegSize(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let offset=2;
  while(offset+4<=bytes.length&&bytes[offset]===0xff){
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    if(marker===0xda||marker===0xd9||offset+2>bytes.length)break;
    if(marker===1||marker>=0xd0&&marker<=0xd7)continue;
    const length=view.getUint16(offset);
    if(length<2||offset+length>bytes.length)break;
    if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)&&length>=7)
      return [view.getUint16(offset+5),view.getUint16(offset+3)];
    offset+=length;
  }
  return null;
}

function webpSize(bytes){
  if(bytes.length<25)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),kind=ascii(bytes,12,4);
  if(kind==='VP8X'&&bytes.length>=30){
    if(bytes[20]&2)throw Error('请先将动态 WebP 导出为单帧');
    const u24=offset=>bytes[offset]+bytes[offset+1]*256+bytes[offset+2]*65536;
    return [u24(24)+1,u24(27)+1];
  }
  if(kind==='VP8L'&&bytes[20]===0x2f){
    const bits=view.getUint32(21,true);
    return [(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1];
  }
  if(kind==='VP8 '&&bytes.length>=30&&matches(bytes,23,[0x9d,1,0x2a]))
    return [view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff];
  return null;
}

async function decode(file){
  if(typeof createImageBitmap==='function'){
    try{
      const image=await createImageBitmap(file,{imageOrientation:'from-image'});
      return {image,width:image.width,height:image.height,dispose:()=>image.close()};
    }catch{}
  }
  const image=new Image(),url=URL.createObjectURL(file);
  image.src=url;
  try{
    await image.decode();
    return {image,width:image.naturalWidth,height:image.naturalHeight,dispose:()=>URL.revokeObjectURL(url)};
  }catch(error){
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function prepareDrawingImage(file,{preserveProfile=false}={}){
  if(!acceptsDrawingImage(file))throw Error('请选择 PNG、JPEG、WebP 或 TIFF 图片');
  if(file.size>maxBytes)throw Error('图片不能超过 24 MiB');
  const header=new Uint8Array(await file.slice(0,32).arrayBuffer());
  if(matches(header,0,pngSignature))return {file,size:await clipboardPngSize(file)};
  if(preserveProfile){
    let format;
    if(matches(header,0,[0xff,0xd8,0xff]))format='jpeg';
    else if(ascii(header,0,4)==='RIFF'&&ascii(header,8,4)==='WEBP')format='webp';
    else if(matches(header,0,[0x49,0x49,42,0])||matches(header,0,[0x4d,0x4d,0,42]))format='tiff';
    if(!format)throw Error('无法读取图片格式');
    // The importer places the oriented image using the same decode that reads its ICC.
    return {file,format};
  }
  const size=matches(header,0,[0xff,0xd8,0xff])?jpegSize(new Uint8Array(await file.arrayBuffer())):
    ascii(header,0,4)==='RIFF'&&ascii(header,8,4)==='WEBP'?webpSize(header):null;
  if(!size)throw Error('无法读取图片格式或尺寸');
  if(!validSize(size))throw Error('图片宽高不能超过 8192 像素');
  let decoded;
  try{decoded=await decode(file);}
  catch{throw Error('浏览器无法解码这张图片');}
  try{
    const {image,width,height}=decoded;
    if(!validSize([width,height]))throw Error('图片宽高不能超过 8192 像素');
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{alpha:true,colorSpace:'srgb'});
    if(!context)throw Error('浏览器无法创建图片画布');
    context.drawImage(image,0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    canvas.width=canvas.height=1;
    if(!blob)throw Error('浏览器无法转换图片');
    if(blob.size>maxBytes)throw Error('转换后的 PNG 超过 24 MiB，请缩小图片后导入');
    const name=(file.name.replace(/\.[^.]*$/,'')||'导入图片')+'.png';
    return {file:new File([blob],name,{type:'image/png'}),size:[width,height]};
  }finally{decoded.dispose();}
}

export function chooseOpenImageSpace(file,signal){
  const dialog=document.createElement('dialog');
  dialog.className='image-size-dialog image-profile-dialog';dialog.setAttribute('aria-label','打开图像');
  dialog.innerHTML=`<form><h3>打开图像</h3><p class="profile-source"></p>
    <label>源配置<select aria-label="打开图像的源配置"></select></label>
    <div class="profile-file" hidden><label>自定 ICC</label><button type="button" class="profile-choose-file">选择配置文件…</button><input type="file" accept=".icc,.icm" hidden></div>
    <label>文档空间<select aria-label="打开图像的颜色空间"></select></label>
    <p class="profile-source profile-open-note"></p>
    <footer><button type="button">取消</button><button class="primary" type="submit">打开</button></footer></form>`;
  dialog.querySelector('.profile-source').textContent=file.name;
  const select=dialog.querySelector('[aria-label=打开图像的颜色空间]'),note=dialog.querySelector('.profile-open-note');
  fillWorkingSpaces(select);select.prepend(new Option('自动 · 读取源图像配置','auto'));select.value='auto';
  const source=dialog.querySelector('[aria-label=打开图像的源配置]'),fileRow=dialog.querySelector('.profile-file');
  const fileInput=fileRow.querySelector('input'),choose=fileRow.querySelector('button'),submit=dialog.querySelector('[type=submit]');
  fillWorkingSpaces(source,'auto',id=>id!=='linear');
  source.prepend(new Option('读取文件配置','auto'),new Option('指定 ICC 文件…','file'));source.value='auto';
  let profile;
  function update(){
    const raw=select.value==='linear',custom=!raw&&source.value==='file';
    source.disabled=raw;syncSelectMenu(source);
    fileRow.hidden=!custom;submit.disabled=custom&&!profile;
    if(raw){note.textContent='按通道数值打开，适用于粗糙度、法线和蒙版。';return;}
    if(source.value!=='auto'){
      note.textContent='按指定源配置解释原图数值，然后转入文档空间。绘制层使用 8 位通道。';return;
    }
    note.textContent=select.value==='auto'?'识别到的配置会作为文档空间。其他彩色 ICC 转入 ProPhoto RGB，未标记的彩色图按 sRGB 打开。绘制层使用 8 位通道。':
      '按源图像配置转换到所选空间，绘制层使用 8 位通道。';
  }
  select.onchange=source.onchange=update;
  choose.onclick=()=>fileInput.click();
  fileInput.onchange=async()=>{
    const picked=fileInput.files[0];
    profile=null;choose.textContent=picked?.name||'选择配置文件…';update();
    if(!picked)return;
    try{
      outputProfileMode(new Uint8Array(await picked.slice(0,128).arrayBuffer()),picked.size);
      if(fileInput.files[0]===picked){profile=picked;update();}
    }catch(error){if(fileInput.files[0]===picked)note.textContent=error.message;}
  };
  return new Promise(resolve=>{
    let result;
    const close=()=>dialog.close();
    dialog.querySelector('footer button[type=button]').onclick=close;
    dialog.querySelector('form').onsubmit=event=>{event.preventDefault();
      result={openWorkingSpace:select.value};
      if(!source.disabled&&source.value!=='auto'){
        if(source.value==='file'){if(!profile)return;result.profile=profile;}
        else result.sourceSpace=source.value;
      }
      close();};
    dialog.onclose=()=>{signal.removeEventListener('abort',close);dialog.remove();resolve(result);};
    document.body.append(dialog);
    for(const picker of [source,select])enhanceSelectMenu(picker,{menuClass:'image-profile-menu'});
    update();dialog.showModal();
    signal.addEventListener('abort',close,{once:true});dialog.querySelector('[type=submit]').focus();
  });
}
