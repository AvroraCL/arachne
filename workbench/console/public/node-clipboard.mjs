let copied=null;

function bridge(win){
  const desktop=win.arachneDesktop;
  if(typeof desktop?.readNodeClipboard==='function'&&typeof desktop?.writeNodeClipboard==='function')
    return {read:()=>desktop.readNodeClipboard(),write:text=>desktop.writeNodeClipboard(text)};
  const webkit=win.webkit?.messageHandlers?.arachneNodeClipboard;
  if(webkit)return {read:()=>webkit.postMessage({action:'read'}),write:text=>webkit.postMessage({action:'write',text})};
  return {read:()=>win.navigator.clipboard.readText(),write:text=>win.navigator.clipboard.writeText(text)};
}

export async function writeNodeClipboard(win,text){
  copied=text;
  try{await bridge(win).write(text);}catch{}
}

export async function readNodeClipboard(win){
  // A successful read of an empty or non-node clipboard must not resurrect
  // a stale copy. Keep a window-local fallback only when permission failed.
  try{return await bridge(win).read();}catch{return copied;}
}
