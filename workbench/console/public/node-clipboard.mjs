const states=new WeakMap();
function clipboardState(win){
  let value=states.get(win);
  if(!value){value={copied:null,writing:null};states.set(win,value);}
  return value;
}

function bridge(win){
  const desktop=win.arachneDesktop;
  if(typeof desktop?.readNodeClipboard==='function'&&typeof desktop?.writeNodeClipboard==='function')
    return {read:()=>desktop.readNodeClipboard(),write:text=>desktop.writeNodeClipboard(text)};
  const webkit=win.webkit?.messageHandlers?.arachneNodeClipboard;
  if(webkit)return {read:()=>webkit.postMessage({action:'read'}),write:text=>webkit.postMessage({action:'write',text})};
  return {read:()=>win.navigator.clipboard.readText(),write:text=>win.navigator.clipboard.writeText(text)};
}

export async function writeNodeClipboard(win,text){
  const state=clipboardState(win);
  state.copied=text;
  const write=async()=>{try{await bridge(win).write(text);}catch{}};
  const task=state.writing?state.writing.then(write):write();
  state.writing=task;
  await task;
  if(state.writing===task)state.writing=null;
}

export async function readNodeClipboard(win){
  // A successful read of an empty or non-node clipboard must not resurrect
  // a stale copy. Keep a window-local fallback only when permission failed.
  const state=clipboardState(win);
  while(state.writing)await state.writing;
  try{return await bridge(win).read();}catch{return state.copied;}
}
