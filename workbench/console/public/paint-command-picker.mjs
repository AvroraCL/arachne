import {createSearchPicker,searchTerms} from './search-picker.mjs';
import {compositionKey} from './text-input.mjs';

const commands=[
  {target:'new',name:'新建工程',group:'文件',keys:'create project'},
  {target:'open-projects',name:'打开工程',group:'文件',keys:'切换项目 open project'},
  {target:'open-paint-import',name:'打开涂装 ZIP',group:'文件',keys:'导入 zip archive import'},
  {target:'open-glb-migration',name:'迁移为 GLB 工程',group:'文件',keys:'blend blender migrate'},
  {target:'open-project-copy',name:'另存为工程',group:'文件',keys:'独立副本 save as copy'},
  {target:'open-project-details',name:'工程详情',group:'文件',keys:'修订号 details'},
  {target:'open-delivery',name:'导出',group:'文件',keys:'贴图模型交付 export glb zip'},
  {target:'create-paint-backup',name:'生成工程副本',group:'文件',keys:'备份 duplicate backup'},
  {target:'undo',name:'撤销',group:'编辑',keys:'undo'},
  {target:'redo',name:'重做',group:'编辑',keys:'redo'},
  {target:'open-history',name:'历史记录',group:'编辑',keys:'history'},
  {target:'open-paint-render',name:'路径追踪出图',group:'渲染',keys:'render path tracing png exr'},
  {target:'open-render-batch',name:'相机批量出图',group:'渲染',keys:'镜头书签 batch render cameras'},
  {target:'open-render-results',name:'渲染结果',group:'渲染',keys:'render results'},
  {target:'open-task-monitor',name:'后台任务',group:'渲染',keys:'进度 日志 jobs tasks'},
  {target:'preview',name:'生成 4K 预览',group:'渲染',keys:'烘焙贴图 bake preview'},
  {target:'open-render-settings',name:'渲染设置',group:'渲染',keys:'render settings'},
  {area:'modeling',name:'切换到建模',group:'工作区',keys:'modeling'},
  {area:'material',name:'切换到材质',group:'工作区',keys:'涂装 material'},
  {area:'drawing',name:'切换到绘制',group:'工作区',keys:'绘图画布 drawing paint'},
  {target:'open-workspace-layouts',name:'工作区布局',group:'窗口',keys:'布局导入导出 workspace layout'},
  {target:'open-settings',name:'设置',group:'应用',keys:'偏好 preferences settings'},
];

export function setupCommandPicker({canOpen}){
  const dialog=document.getElementById('command-picker');
  const input=document.getElementById('command-search');
  const trigger=document.getElementById('open-command-picker');
  const list=document.getElementById('command-results');
  const entries=commands.map(command=>({
    ...command,
    control:command.area?document.querySelector('[data-area-mode="'+command.area+'"]'):document.getElementById(command.target),
    search:searchTerms([command.name,command.group,command.keys].join(' ')).join(' ')
  }));
  const picker=createSearchPicker({
    input,list,message:document.getElementById('command-results-message'),onSelect:invoke
  });
  const enabled=entry=>entry?.control&&!entry.control.disabled&&!entry.control.hidden;

  function invoke(value){
    const entry=entries[Number(value)];
    if(!enabled(entry))return;
    dialog.close();
    entry.control.click();
  }

  function render(){
    const terms=searchTerms(input.value);
    picker.setItems(entries.flatMap((entry,index)=>{
      if(!enabled(entry)||!terms.every(term=>entry.search.includes(term)))return [];
      const name=document.createElement('span'),group=document.createElement('span');
      name.className='picker-row-name';name.textContent=entry.name;
      group.className='picker-row-detail';group.textContent=entry.group;
      return [{value:String(index),content:[name,group]}];
    }),'没有匹配的命令');
  }

  function show(){
    if(!canOpen())return false;
    const menu=document.querySelector('.paint-menu[open]');
    if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
    input.value='';render();dialog.showModal();input.focus();
    return true;
  }

  trigger.onclick=show;
  input.oninput=render;
  document.getElementById('close-command-picker').onclick=()=>dialog.close();
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||compositionKey(event)||event.repeat||event.altKey||event.shiftKey)return;
    const primary=event.metaKey||event.ctrlKey;
    if(((primary&&event.key.toLowerCase()==='k')||(!primary&&event.key==='F3'))&&show()){
      event.preventDefault();event.stopPropagation();
    }
  },true);
}
