import {outputProfileMode} from './image-output-profile.mjs';
import {enhanceSelectMenu} from './paint-select.mjs';
import {preferredDisplaySpace} from './image-display-rgb.mjs';

export function chooseOutputProfile(image,sourceLabel,signal,requestProof){
  const dialog=document.createElement('dialog');
  dialog.className='image-size-dialog image-profile-dialog';
  dialog.setAttribute('aria-label','按 ICC 导出副本');
  dialog.innerHTML=`<form>
    <h3>按 ICC 导出副本</h3>
    <p class="profile-source"></p>
    <div class="profile-file"><label for="output-device-profile">目标 ICC</label>
      <button type="button" class="profile-choose-file">选择配置文件…</button>
      <input id="output-device-profile" type="file" accept=".icc,.icm" hidden></div>
    <label>渲染意图<select aria-label="渲染意图"><option value="relative">相对色度</option><option value="perceptual">感知</option></select></label>
    <output aria-live="polite">选择显示器、印刷或灰度配置文件。</output>
    <div class="profile-proof-options"><button class="profile-proof-action" type="button" disabled>预览校样</button>
      <label hidden><input type="checkbox">模拟纸白</label></div>
    <figure hidden><img alt="左侧为原稿，右侧为目标配置的校样"><figcaption><span>原稿</span><span>输出校样</span></figcaption></figure>
    <span class="profile-proof-status" role="status"></span>
    <footer><button type="button">取消</button><button type="submit" class="primary" disabled>导出副本</button></footer>
  </form>`;
  const form=dialog.querySelector('form'),file=form.querySelector('input'),intent=form.querySelector('select');
  const message=form.querySelector('output'),submit=form.querySelector('[type=submit]');
  const preview=form.querySelector('.profile-proof-action'),paper=form.querySelector('[type=checkbox]');
  const chooseFile=form.querySelector('.profile-choose-file');
  chooseFile.onclick=()=>file.click();
  const figure=form.querySelector('figure'),comparison=figure.querySelector('img'),status=form.querySelector('.profile-proof-status');
  form.querySelector('.profile-source').textContent=image.name+' · '+sourceLabel+' · '+image.width+' × '+image.height;
  let mode,result,proofRequest,proofUrl,showProof=false;
  function clearProof(){
    proofRequest?.abort();proofRequest=null;
    figure.hidden=true;comparison.removeAttribute('src');
    if(proofUrl)URL.revokeObjectURL(proofUrl);
    proofUrl=null;status.textContent='';
  }
  async function refreshProof(){
    clearProof();
    if(!showProof||!mode)return;
    const request=proofRequest=new AbortController();
    const space=preferredDisplaySpace();
    status.textContent='正在生成校样…';
    try{
      const blob=await requestProof({file:file.files[0],intent:intent.value},
        {space,paper:mode==='CMYK'&&paper.checked},request.signal);
      if(request.signal.aborted)return;
      proofUrl=URL.createObjectURL(blob);comparison.src=proofUrl;
      await comparison.decode();
      if(request.signal.aborted)return;
      figure.style.setProperty('--proof-ratio',comparison.naturalWidth/comparison.naturalHeight);
      figure.hidden=false;status.textContent=(space==='display-p3'?'Display P3':'sRGB')+' 校样预览';
    }catch(error){if(!request.signal.aborted)status.textContent=error.message;}
  }
  preview.onclick=()=>{showProof=!showProof;preview.textContent=showProof?'收起校样':'预览校样';void refreshProof();};
  intent.onchange=paper.onchange=refreshProof;
  file.onchange=async()=>{
    const selected=file.files[0];submit.disabled=preview.disabled=true;mode=null;paper.parentElement.hidden=true;clearProof();
    chooseFile.title=selected?.name||'选择 ICC 或 ICM 文件';chooseFile.textContent=selected?.name||'选择配置文件…';
    if(!selected){message.textContent='请选择 ICC 配置文件。';return;}
    try{
      const header=new Uint8Array(await selected.slice(0,128).arrayBuffer());
      if(selected!==file.files[0]||!dialog.open)return;
      mode=outputProfileMode(header,selected.size);
      message.textContent=mode==='CMYK'?'CMYK TIFF · 透明区域合成至纸白':'PNG · '+(mode==='GRAY'?'灰度':'RGB')+' · 保留透明度';
      submit.disabled=preview.disabled=false;paper.parentElement.hidden=mode!=='CMYK';void refreshProof();
    }catch(error){if(selected===file.files[0])message.textContent=error.message;}
  };
  form.querySelector('footer [type=button]').onclick=()=>dialog.close();
  return new Promise(resolve=>{
    const close=()=>dialog.close();
    dialog.onclose=()=>{clearProof();signal?.removeEventListener('abort',close);dialog.remove();resolve(result);};
    form.onsubmit=event=>{
      event.preventDefault();
      if(!mode||!file.files[0])return;
      result={file:file.files[0],mode,intent:intent.value};dialog.close();
    };
    document.body.append(dialog);enhanceSelectMenu(intent);dialog.showModal();
    signal?.addEventListener('abort',close,{once:true});chooseFile.focus();
  });
}
