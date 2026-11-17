export function createImageUVGuide({image,toggle,notice,read,onChange,enabled=false}){
  let key=null,request=null,objectUrl=null,error=null;
  function clear(){
    request?.abort();request=null;
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    objectUrl=null;error=null;
    image.removeAttribute('src');
  }
  function render(){
    toggle.setAttribute('aria-pressed',String(enabled&&!toggle.disabled));
    toggle.title=toggle.disabled?'打开图像文档后可查看原 UV 参考':error?'UV 参考加载失败 · 单击重试':'显示原 UV 参考';
    image.hidden=!enabled||toggle.disabled||!objectUrl;
    notice.hidden=!enabled||toggle.disabled||(!request&&!objectUrl&&!error);
    notice.dataset.error=String(!!error);
    notice.textContent=error?'UV 参考加载失败 · 点击 UV 重试':request?'正在读取原 UV…':'UV 岛边界 · 橙色保护区 · 红色共享 UV';
    notice.title=error||notice.textContent;
  }
  function sync(){
    const state=read();
    toggle.disabled=!state?.visible;
    if(state?.key!==key){
      clear();key=state?.key;
    }
    if(!state?.visible&&request){request.abort();request=null;}
    if(!state?.visible||!enabled||request||objectUrl||error){render();return;}
    const controller=request=new AbortController();
    render();
    void fetch('/api/projects/'+state.id+'/paint/uv-layout',{signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw Error((await response.json()).error||'无法读取原 UV');
        return response.blob();
      }).then(blob=>{
        if(request!==controller)return;
        objectUrl=URL.createObjectURL(blob);
        image.src=objectUrl;
      }).catch(failure=>{
        if(request===controller)error=failure.message;
      }).finally(()=>{
        if(request===controller){request=null;render();}
      });
  }
  toggle.onclick=()=>{
    if(error){error=null;sync();return;}
    enabled=!enabled;
    if(!enabled&&request){request.abort();request=null;}
    sync();onChange();
  };
  return {sync,get enabled(){return enabled;},dispose:clear};
}
