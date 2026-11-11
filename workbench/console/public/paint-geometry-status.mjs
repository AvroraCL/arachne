export function showGeometryStatus({status,log,retry},state){
  const pending=state&&['queued','running'].includes(state.status),failed=state?.status==='failed';
  status.hidden=!pending&&!failed;
  status.dataset.state=state?.status||'';
  status.textContent=state?.status==='queued'?'表面 · 排队中':pending?'表面 · '+(state.stage||'准备中'):
    failed?'表面准备失败':'';
  status.title=state?.error||state?.stage||'';
  log.hidden=!state?.logUrl;
  if(state?.logUrl)log.href=state.logUrl;
  retry.hidden=!failed;
  retry.disabled=!!pending;
}
