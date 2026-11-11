const valid=value=>typeof value==='string'&&/^#[a-f0-9]{6}$/i.test(value);
export function maskGray(hex){
  if(!valid(hex))throw Error('颜色无效');
  const [r,g,b]=hex.slice(1).match(/../g).map(value=>parseInt(value,16));
  return Math.round(.2126*r+.7152*g+.0722*b)/255;
}
export function grayColor(hex){
  const value=Math.round(maskGray(hex)*255).toString(16).padStart(2,'0');
  return '#'+value.repeat(3);
}
export function createPaintColors(saved){
  const pairs={};
  for(const target of ['paint','mask']){
    const pair=saved?.[target]||{};
    pairs[target]={foreground:valid(pair.foreground)?pair.foreground.toLowerCase():'#000000',
      background:valid(pair.background)?pair.background.toLowerCase():'#ffffff'};
    if(target==='mask')for(const key of ['foreground','background'])pairs[target][key]=grayColor(pairs[target][key]);
  }
  return {
    pair(target='paint'){return {...pairs[target]};},
    set(target,slot,value){
      if(!Object.hasOwn(pairs,target)||!['foreground','background'].includes(slot)||!valid(value))throw Error('颜色参数无效');
      pairs[target][slot]=target==='mask'?grayColor(value):value.toLowerCase();
    },
    swap(target='paint'){
      const pair=pairs[target];[pair.foreground,pair.background]=[pair.background,pair.foreground];
    },
    reset(target='paint'){pairs[target]={foreground:'#000000',background:'#ffffff'};},
    snapshot(){return {paint:{...pairs.paint},mask:{...pairs.mask}};}
  };
}
