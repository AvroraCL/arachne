import {cyclesProgressLabel} from './cycles-progress-ui.mjs';
import {renderDownloadFilename} from './render-output-ui.mjs';

const taskNames={
  'paint-draft':'草稿预览','paint-preview':'4K 烘焙','paint-render':'路径追踪出图',
  'paint-backup':'工程副本','paint-export':'交付 ZIP','paint-texture-export':'工程与贴图 ZIP','paint-glb-export':'模型 GLB',
};
const statusNames={queued:'排队中',running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const taskTime=new Intl.DateTimeFormat('zh-CN',{timeStyle:'medium',hour12:false});
const active=job=>job?.status==='running'||job?.status==='queued';
const stopped=job=>['failed','cancelled','interrupted'].includes(job?.status);

function matches(job,filter){
  if(filter==='active')return active(job);
  if(filter==='completed')return job.status==='completed';
  if(filter==='stopped')return stopped(job);
  return true;
}

export function setupTaskMonitor({project,jobs,busy,canOpen,loadLog,cancel,retry}){
  const byId=id=>document.getElementById('task-monitor'+id);
  const dialog=byId(''),trigger=document.getElementById('open-task-monitor');
  const list=byId('-list'),empty=byId('-empty'),detail=byId('-detail');
  const error=byId('-error'),stage=byId('-stage'),progress=byId('-progress');
  const download=byId('-download'),cancelButton=byId('-cancel'),retryButton=byId('-retry');
  const log=byId('-log'),logText=byId('-log-text'),logStatus=byId('-log-status');
  const filters=[...dialog.querySelectorAll('[data-task-filter]')];
  let filter='all',selected=null,shown=null,logRequest=0,rowKey='';
  let rows=new Map();

  function setText(node,text){
    if(node.textContent!==text)node.textContent=text;
  }

  function select(id){
    if(selected===id)return;
    selected=id;error.textContent='';
    sync();
  }

  function buildRows(visible){
    rows=new Map(visible.map(job=>{
      const row=document.createElement('li'),button=document.createElement('button');
      const name=document.createElement('span'),revision=document.createElement('small'),time=document.createElement('time'),status=document.createElement('span');
      name.className='task-row-name';status.className='task-row-status';
      name.textContent=job.renderBookmark?.name||taskNames[job.type]||'工程任务';
      name.title=job.renderBookmark?'相机出图 · '+job.renderBookmark.name:name.textContent;
      revision.textContent='r'+job.revision;
      const created=Date.parse(job.created);
      if(Number.isFinite(created)){time.dateTime=job.created;time.textContent=taskTime.format(created);time.title=new Date(created).toLocaleString('zh-CN');}
      button.type='button';button.dataset.jobId=job.id;button.onclick=()=>select(job.id);
      button.append(name,revision,time,status);row.append(button);
      return [job.id,{row,button,status}];
    }));
    const focused=list.contains(document.activeElement);
    list.replaceChildren(...[...rows.values()].map(view=>view.row));
    if(focused)(rows.get(selected)?.button||filters.find(button=>button.dataset.taskFilter===filter))?.focus({preventScroll:true});
  }

  function sync(){
    const doc=project();
    trigger.disabled=!doc;
    if(!dialog.open)return;
    const visible=jobs().filter(job=>matches(job,filter));
    const key=JSON.stringify(visible.map(job=>job.id));
    if(!visible.some(job=>job.id===selected))selected=visible[0]?.id||null;
    if(key!==rowKey){rowKey=key;buildRows(visible);}
    for(const job of visible){
      const view=rows.get(job.id);
      view.button.setAttribute('aria-pressed',String(job.id===selected));
      view.status.dataset.status=job.status;
      setText(view.status,statusNames[job.status]||job.status);
    }
    const job=visible.find(value=>value.id===selected);
    setText(empty,job?'':'没有符合条件的任务');
    detail.hidden=!job;
    if(shown!==selected){
      shown=selected;logRequest++;log.open=false;logText.textContent=logStatus.textContent='';
    }
    setText(stage,job?(job.error||(active(job)&&cyclesProgressLabel(job.progress))||job.stage||''):'');
    const sampling=job?.status==='running'&&job.progress?.phase==='sample'&&Number(job.progress.total)>0;
    progress.hidden=!sampling;
    if(sampling){progress.max=job.progress.total;progress.value=job.progress.sample;}
    cancelButton.hidden=!active(job);cancelButton.disabled=busy();
    retryButton.hidden=!job||!stopped(job)||!taskNames[job.type]||job.type!=='paint-render'&&job.revision!==doc?.revision;
    retryButton.disabled=busy();
    const output=job?.status==='completed'&&(job.packageUrl||job.archiveUrl||job.glbUrl||job.outputUrl||job.renderUrl);
    download.hidden=!output;
    if(output){download.href=output;download.download=job.type==='paint-render'?renderDownloadFilename(job,doc.name):output.split('/').at(-1);}
    else download.removeAttribute('href');
  }

  async function readLog(){
    const doc=project();
    if(!dialog.open||!log.open||!doc||!selected)return;
    const id=selected,token=++logRequest;
    logStatus.textContent='正在读取…';
    try{
      const result=await loadLog(doc.id,id);
      if(token!==logRequest||!dialog.open)return;
      logText.textContent=result.text;
      logStatus.textContent=result.truncated?'显示日志末尾 32 KiB':result.text?'':'暂无日志';
      logText.scrollTop=logText.scrollHeight;
    }catch(failure){
      if(token===logRequest&&dialog.open)logStatus.textContent=failure.message;
    }
  }

  function setFilter(value){
    filter=value;
    for(const option of filters)option.setAttribute('aria-pressed',String(option.dataset.taskFilter===filter));
    sync();
  }
  for(const button of filters)button.onclick=()=>setFilter(button.dataset.taskFilter);
  const act=async action=>{
    const job=jobs().find(value=>value.id===selected);
    if(!job||busy())return;
    error.textContent='';
    return await action(job,error);
  };
  cancelButton.onclick=()=>act(cancel);
  retryButton.onclick=async()=>{
    const next=await act(retry);
    if(!next||!dialog.open)return;
    if(filter!=='all')setFilter('all');
    select(next.id);
  };
  trigger.onclick=()=>{
    if(!project()||!canOpen())return;
    const menu=trigger.closest('details');
    menu.open=false;menu.querySelector('summary')?.focus();
    error.textContent='';
    dialog.showModal();
    sync();
  };
  dialog.addEventListener('close',()=>{if(!dialog.open){logRequest++;shown=null;rowKey='';}});
  document.getElementById('close-task-monitor').onclick=()=>dialog.close();
  log.ontoggle=()=>{if(log.open)void readLog();};
  byId('-refresh-log').onclick=()=>void readLog();
  return {sync};
}
