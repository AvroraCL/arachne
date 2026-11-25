// D50-adapted RGB colorants of the bundled ICC profiles, multiplied by the
// inverse sRGB colorant matrix. Only the display copy is gamut-clipped.
const toSRGB={
  'display-p3':[1.2248652,-.2248408,-.0000244,-.0419525,1.041974,-.0000215,-.0196194,-.0786357,1.0982551],
  'adobe-rgb':[1.3982751,-.3982212,-.0000539,.0001025,.9998916,.0000059,.0000325,-.0429497,1.0429172],
  'prophoto-rgb':[2.0342011,-.7274671,-.306734,-.2286419,1.2316059,-.002964,-.0085179,-.1532819,1.1617999]
};
const decoders=new Map();
let encoded;
export function writeDisplayRGB(target,pixels,space){
  const m=toSRGB[space];
  if(!m){if(target!==pixels)target.set(pixels);return;}
  if(!encoded)encoded=Uint8Array.from({length:65536},(_,i)=>{
    const x=i/65535;
    return Math.round(255*(x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055));
  });
  if(!decoders.has(space))decoders.set(space,Float64Array.from({length:256},(_,i)=>{
    const x=i/255;
    if(space==='adobe-rgb')return x**(563/256);
    if(space==='prophoto-rgb')return x<1/32?x/16:x**1.8;
    return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
  }));
  const linear=decoders.get(space);
  const byte=x=>encoded[Math.round(Math.max(0,Math.min(1,x))*65535)];
  for(let i=0;i<pixels.length;i+=4){
    const r=linear[pixels[i]],g=linear[pixels[i+1]],b=linear[pixels[i+2]];
    target[i]=byte(m[0]*r+m[1]*g+m[2]*b);
    target[i+1]=byte(m[3]*r+m[4]*g+m[5]*b);
    target[i+2]=byte(m[6]*r+m[7]*g+m[8]*b);
    target[i+3]=pixels[i+3];
  }
}
