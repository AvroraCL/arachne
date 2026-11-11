import {cyclesDeviceText,cyclesDeviceBlocked} from './paint-cycles-devices.mjs';
import {cyclesProgressLabel} from './cycles-progress-ui.mjs';
import {cyclesFormatLabel,showRenderDownload,showRenderPassDownload} from './render-output-ui.mjs';
import {renderRegionPixels} from './render-region.mjs';

const active=job=>['queued','running'].includes(job?.status);
const canRetry=job=>['failed','cancelled','interrupted'].includes(job?.status);
const statusLabels={queued:'排队中',running:'渲染中',completed:'已完成',cancelled:'已取消',failed:'失败',interrupted:'已中断'};
const settingsDevice={auto:'自动选择设备',cpu:'CPU',gpu:'GPU'};
const framingLabel={auto:'完整模型',viewport:'当前视口',saved:'工程渲染相机'};

export function createPaintRenderResults({read,run,post,settings,camera,openSettings,openExport,devices}){
  const $=id=>document.getElementById(id),dialog=$('paint-render-dialog'),error=$('paint-render-error');
  const list=$('paint-render-list'),info=$('paint-render-info'),image=$('paint-render-image'),sampling=$('paint-render-samples');
  const download=$('paint-render-download'),report=$('paint-render-report'),log=$('paint-render-log');
  const passes=$('paint-render-passes');
  const start=$('start-paint-render'),cancel=$('cancel-paint-render'),retry=$('retry-paint-render');
  const background=$('render-background-status'),backgroundText=background.querySelector('span');
  let projectId=null,selectedId=null,pending=false,listKey='',backgroundJob=null;

  function syncBackground(doc,jobs){
    const eligible=doc?jobs.filter(job=>active(job)&&['paint-render','paint-export'].includes(job.type)):[];
    const job=eligible.find(item=>item.status==='running')||eligible[0];
    backgroundJob=job?{projectId:doc.id,id:job.id,type:job.type}:null;
    background.hidden=!job;
    if(!job)return;
    const title=job.type==='paint-export'?'导出':'渲染',progress=job.progress,hasSamples=progress?.phase==='sample'&&progress.total>0;
    const percent=hasSamples?Math.max(0,Math.min(100,Math.round(100*progress.sample/progress.total))):null;
    const text=percent!==null?title+' '+percent+'%':job.status==='queued'?title+'排队中':title+'中';
    if(backgroundText.textContent!==text)backgroundText.textContent=text;
    background.title=[title+' r'+job.revision,cyclesProgressLabel(progress)||job.stage||statusLabels[job.status],
      eligible.length>1?'另外 '+(eligible.length-1)+' 个任务等待':null].filter(Boolean).join(' · ');
    background.setAttribute('aria-label',text+' · 查看任务');
    background.toggleAttribute('data-sampling',hasSamples);
    if(hasSamples)background.style.setProperty('--cycles-progress',String(percent/100));
    else background.style.removeProperty('--cycles-progress');
  }

  function sync(){
    const {doc,jobs,busy}=read();
    syncBackground(doc,jobs);
    if(projectId!==doc?.id){projectId=doc?.id;selectedId=null;error.textContent='';}
    if(!dialog.open)return;
    const recent=jobs.filter(job=>job.type==='paint-render');
    const selected=recent.find(job=>job.id===selectedId)||recent[0],running=recent.find(active);
    const result=selected?.renderUrl&&selected.status==='completed'?selected:recent.find(job=>job.status==='completed'&&job.renderUrl);
    const values=settings(),blocked=busy||pending;
    const framing=framingLabel[values.framing];
    const region=renderRegionPixels(doc?.paint.renderRegion,values.width,values.height);
    $('paint-render-summary').textContent=`${values.width} × ${values.height} · ${values.samples} 次采样 · ${settingsDevice[values.device]} · ${framing}`+
      ` · ${cyclesFormatLabel(values.fileFormat)}`+(values.bitDepth?` ${values.bitDepth} 位`:'')+
      (values.renderPasses?.length?` · ${values.renderPasses.length} 个渲染通道`:'')+
      (region?` · ${region.crop?'裁切':'区域渲染'} ${region.output.join(' × ')}`:'');
    const hardware=devices.read(),deviceLabel=$('paint-render-devices');
    const description=cyclesDeviceText(hardware);
    if(deviceLabel.textContent!==description)deviceLabel.textContent=description;
    const supportsPasses=options=>!options?.renderPasses?.length||hardware.value?.renderPasses!==false;
    start.disabled=!doc||blocked||!!running||cyclesDeviceBlocked(hardware,values.device)||!supportsPasses(values);
    cancel.hidden=!active(selected);cancel.disabled=blocked;
    retry.hidden=!canRetry(selected);retry.disabled=blocked||!!running||cyclesDeviceBlocked(hardware,selected?.paintSettings?.device)||!supportsPasses(selected?.paintSettings);
    start.title=supportsPasses(values)?'':'当前 Blender 不支持已选渲染通道';
    const progress=active(selected)?selected.progress:null;
    sampling.hidden=progress?.phase!=='sample';
    if(!sampling.hidden){sampling.max=progress.total;sampling.value=progress.sample;}
    const detail=selected?[
      `r${selected.revision} · ${cyclesProgressLabel(progress)||selected.stage||statusLabels[selected.status]}`,
      selected.cycles?`${selected.cycles.device} · ${selected.cycles.resolution.join(' × ')} · ${selected.cycles.samples} 次采样`:selected.error,
      selected.cycles?.render_effective?.bitDepth?`${cyclesFormatLabel(selected.cycles.render_effective.fileFormat)} · ${selected.cycles.render_effective.bitDepth} 位`:'',
      selected.cycles?.gpu_fallback?'已从 GPU 切换至 CPU':'',
      result&&result.id!==selected.id?`画面显示最近成功的结果 · r${result.revision}`:'',
    ].filter(Boolean).join('\n'):'渲染会使用工程当前的模型、材质和 4K 贴图。';
    if(info.textContent!==detail)info.textContent=detail;
    log.hidden=!selected;
    if(selected)log.href=`/api/projects/${projectId}/jobs/${selected.id}/files/run.log`;
    image.hidden=download.hidden=report.hidden=!result;
    showRenderPassDownload(passes,result);
    $('paint-render-placeholder').hidden=!!result;
    if(result){
      if(image.getAttribute('src')!==result.renderUrl)image.src=result.renderUrl;
      image.alt=`工程修订 r${result.revision} 的 Cycles 渲染结果`;
      showRenderDownload(download,result,doc.name);
      report.href=result.validationUrl;
    }else image.removeAttribute('src');
    const visible=recent.slice(0,12);
    if(selected&&!visible.includes(selected))visible.push(selected);
    const key=JSON.stringify([selected?.id,visible.map(job=>[job.id,job.status])]);
    if(listKey!==key){
      listKey=key;
      const focused=list.contains(document.activeElement)?document.activeElement.dataset.job:null;
      list.replaceChildren(...visible.map(job=>{
        const button=document.createElement('button');
        button.type='button';button.dataset.job=job.id;
        button.setAttribute('aria-pressed',String(job.id===selected?.id));
        const label=document.createElement('span'),when=document.createElement('small');
        label.textContent=`r${job.revision} · ${statusLabels[job.status]||job.status}`;
        when.textContent=new Date(job.created).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        button.append(label,when);
        button.onclick=()=>{selectedId=job.id;error.textContent='';sync();};
        return button;
      }));
      if(focused)[...list.children].find(button=>button.dataset.job===focused)?.focus();
    }
  }
  const current=()=>{const jobs=read().jobs.filter(job=>job.type==='paint-render');return jobs.find(job=>job.id===selectedId)||jobs[0];};
  async function act(action){
    if(pending)return;
    pending=true;error.textContent='';sync();
    try{await run(action,error);}finally{pending=false;sync();}
  }
  start.onclick=()=>act(async()=>{
    const {doc}=read();
    const job=await post('render',{requestId:crypto.randomUUID(),settings:camera()});
    if(doc.id===read().doc?.id)selectedId=job.id;
  });
  cancel.onclick=()=>act(()=>post('render-cancel',{jobId:current().id}));
  retry.onclick=()=>act(async()=>{
    const job=await post('render-retry',{jobId:current().id,requestId:crypto.randomUUID()});
    selectedId=job.id;
  });
  $('open-paint-render').onclick=()=>{
    if(!read().doc||dialog.open)return;
    $('open-paint-render').closest('details').open=false;
    dialog.showModal();sync();void devices.check();
  };
  background.onclick=()=>{
    if(!backgroundJob||backgroundJob.projectId!==read().doc?.id)return;
    if(backgroundJob.type==='paint-export'){openExport();return;}
    selectedId=backgroundJob.id;
    $('open-paint-render').click();
  };
  $('close-paint-render').onclick=()=>dialog.close();
  $('paint-render-settings').onclick=()=>{dialog.close();openSettings();};
  devices.subscribe(sync);
  return {sync,open:()=>$('open-paint-render').click()};
}
