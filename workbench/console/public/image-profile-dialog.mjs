import {outputProfileMode} from './image-output-profile.mjs';
import {enhanceSelectMenu} from './paint-select.mjs';

export function chooseOutputProfile(image,sourceLabel,signal){
  const dialog=document.createElement('dialog');
  dialog.className='image-size-dialog image-profile-dialog';
  dialog.setAttribute('aria-label','按 ICC 导出副本');
  dialog.innerHTML=`<form>
    <h3>按 ICC 导出副本</h3>
    <p class="profile-source"></p>
    <label class="profile-file">目标 ICC<input type="file" accept=".icc,.icm" required></label>
    <label>渲染意图<select aria-label="渲染意图"><option value="relative">相对色度</option><option value="perceptual">感知</option></select></label>
    <output aria-live="polite">选择显示器、印刷或灰度配置文件。</output>
    <footer><button type="button">取消</button><button type="submit" class="primary" disabled>导出副本</button></footer>
  </form>`;
  const form=dialog.querySelector('form'),file=form.querySelector('input'),intent=form.querySelector('select');
  const message=form.querySelector('output'),submit=form.querySelector('[type=submit]');
  form.querySelector('.profile-source').textContent=image.name+' · '+sourceLabel+' · '+image.width+' × '+image.height;
  let mode,result;
  file.onchange=async()=>{
    const selected=file.files[0];submit.disabled=true;mode=null;
    if(!selected){message.textContent='请选择 ICC 配置文件。';return;}
    try{
      const header=new Uint8Array(await selected.slice(0,128).arrayBuffer());
      if(selected!==file.files[0]||!dialog.open)return;
      mode=outputProfileMode(header,selected.size);
      message.textContent=mode==='CMYK'?'CMYK TIFF · 透明区域合成至纸白':'PNG · '+(mode==='GRAY'?'灰度':'RGB')+' · 保留透明度';
      submit.disabled=false;
    }catch(error){if(selected===file.files[0])message.textContent=error.message;}
  };
  form.querySelector('[type=button]').onclick=()=>dialog.close();
  return new Promise(resolve=>{
    const close=()=>dialog.close();
    dialog.onclose=()=>{signal?.removeEventListener('abort',close);dialog.remove();resolve(result);};
    form.onsubmit=event=>{
      event.preventDefault();
      if(!mode||!file.files[0])return;
      result={file:file.files[0],mode,intent:intent.value};dialog.close();
    };
    document.body.append(dialog);enhanceSelectMenu(intent);dialog.showModal();
    signal?.addEventListener('abort',close,{once:true});file.focus();
  });
}
