// The first or last IME key can arrive outside the composition event pair.
export const compositionKey=event=>event.isComposing||event.keyCode===229||event.key==='Process';

export function trackTextComposition(document){
  let target=null;
  document.addEventListener('compositionstart',event=>{target=event.target;},true);
  document.addEventListener('compositionend',event=>{if(target===event.target)target=null;},true);
  document.addEventListener('focusout',event=>{if(target===event.target)target=null;},true);
  return ()=>target!==null&&target===document.activeElement;
}
