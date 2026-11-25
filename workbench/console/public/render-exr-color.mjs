// Scene-linear RGB. The transforms are from the Linear Rec.709 space in Blender's
// OpenColorIO configuration. ACES uses chromatic adaptation to the ACES white.
const d65=[.3127,.3290],acesWhite=[.32168,.33767];
export const defaultExrSpace='lin_rec709_scene';
export const exrSpaces=Object.freeze({
  lin_rec709_scene:{label:'线性 sRGB / Rec.709',primaries:[.64,.33,.30,.60,.15,.06,...d65]},
  lin_p3d65_scene:{label:'线性 P3-D65',primaries:[.68,.32,.265,.69,.15,.06,...d65],
    matrix:[.822461963,.177538067,0,.033194181,.966805816,0,.017082615,.072397441,.910519898]},
  lin_rec2020_scene:{label:'线性 Rec.2020',primaries:[.708,.292,.170,.797,.131,.046,...d65],
    matrix:[.627403915,.329283059,.043313064,.069097251,.919540346,.011362221,.016391458,.088013351,.895595253]},
  lin_adobergb_scene:{label:'线性 Adobe RGB',primaries:[.64,.33,.21,.71,.15,.06,...d65],
    matrix:[.715125620,.284874409,0,0,1,0,0,.041161969,.958838046]},
  lin_ap1_scene:{label:'ACEScg（AP1）',primaries:[.713,.293,.165,.830,.128,.044,...acesWhite],
    matrix:[.613097429,.339523166,.047379464,.070193708,.916353881,.013452359,.020615593,.109569795,.869814634]},
  lin_ap0_scene:{label:'ACES2065-1（AP0）',primaries:[.73470,.26530,0,1,.00010,-.07700,...acesWhite],
    matrix:[.439632982,.382988721,.177378327,.089776434,.813439429,.096784092,.017541170,.111546576,.870912254]}
});

export function fillExrSpaceSelect(select){
  select.replaceChildren(...Object.entries(exrSpaces).map(([id,spec])=>new Option(spec.label,id)));
}

export function prepareExrPixels(pixels,transparent,space=defaultExrSpace){
  const {matrix}=exrSpaces[space];
  for(let i=0;i<pixels.length;i+=4){
    const alpha=transparent?pixels[i+3]:1,r=pixels[i]*alpha,g=pixels[i+1]*alpha,b=pixels[i+2]*alpha;
    pixels[i]=matrix?matrix[0]*r+matrix[1]*g+matrix[2]*b:r;
    pixels[i+1]=matrix?matrix[3]*r+matrix[4]*g+matrix[5]*b:g;
    pixels[i+2]=matrix?matrix[6]*r+matrix[7]*g+matrix[8]*b:b;
    pixels[i+3]=alpha;
  }
}

function attribute(name,type,data){
  const key=new TextEncoder().encode(name+'\0'+type+'\0'),bytes=new Uint8Array(key.length+4+data.length);
  bytes.set(key);
  new DataView(bytes.buffer).setUint32(key.length,data.length,true);
  bytes.set(data,key.length+4);return bytes;
}

export function taggedExr(bytes,height,space=defaultExrSpace){
  // EXRExporter supplies a single, uncompressed scanline part. Insert color tags
  // before the header terminator and shift the scanline offsets by their size.
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=8;
  while(bytes[end]){
    const sizeAt=bytes.indexOf(0,bytes.indexOf(0,end)+1)+1;
    end=sizeAt+4+view.getUint32(sizeAt,true);
  }
  const xy=new Uint8Array(32),coords=new DataView(xy.buffer);
  exrSpaces[space].primaries.forEach((value,i)=>coords.setFloat32(i*4,value,true));
  const tags=[attribute('chromaticities','chromaticities',xy),attribute('colorInteropID','string',new TextEncoder().encode(space))];
  const delta=BigInt(tags[0].length+tags[1].length);
  for(let line=0;line<height;line++){
    const pos=end+1+8*line;
    view.setBigUint64(pos,view.getBigUint64(pos,true)+delta,true);
  }
  return new Blob([bytes.subarray(0,end),...tags,bytes.subarray(end)],{type:'application/octet-stream'});
}
