// D50-adapted RGB colorants of the bundled ICC profiles, multiplied by the
// inverse sRGB colorant matrix. Clipping applies only after conversion to the display target.
const rec2020=[1.66036035,-.58746738,-.07289297,-.12439522,1.13276038,-.00836516,-.01812828,-.10059072,1.118719];
const grayMatrix=[.2126,.7152,.0722,.2126,.7152,.0722,.2126,.7152,.0722];
const toSRGB={
  'gray-g22':grayMatrix,'gray-linear':grayMatrix,
  'rec709':[.99991849,.00009716,-.00001566,.00008821,.9999266,-.00001481,.00001097,.00000809,.99998095],
  'rec2020':rec2020,'rec2020-g24':rec2020,'linear-srgb':[1,0,0,0,1,0,0,0,1],
  'dci-p3':[1.15743957,-.15484122,-.00259835,-.04140836,1.04547255,-.00406419,-.01801717,-.07859357,1.09661074],
  'acescg':[1.70494801,-.62164526,-.08330275,-.13011616,1.14067849,-.01056233,-.02396787,-.12897918,1.15294705],
  'aces2065-1':[2.52154161,-1.13394309,-.38757385,-.27628209,1.37253264,-.09627978,-.01533337,-.1529886,1.16832546],
  'display-p3':[1.2248652,-.2248408,-.0000244,-.0419525,1.041974,-.0000215,-.0196194,-.0786357,1.0982551],
  'adobe-rgb':[1.3982751,-.3982212,-.0000539,.0001025,.9998916,.0000059,.0000325,-.0429497,1.0429172],
  'prophoto-rgb':[2.0342011,-.7274671,-.306734,-.2286419,1.2316059,-.002964,-.0085179,-.1532819,1.1617999]
};
// Linear sRGB to Display P3 from those same packaged ICC colorants.
const srgbToP3=[.822495627,.177482652,.00002172,.03311608,.966864215,.000019705,.01706429,.072398638,.910537071];
const toP3=Object.fromEntries(Object.entries(toSRGB).map(([space,m])=>[space,
  Array.from({length:9},(_,i)=>{
    const row=Math.floor(i/3)*3,column=i%3;
    return srgbToP3[row]*m[column]+srgbToP3[row+1]*m[column+3]+srgbToP3[row+2]*m[column+6];
  })
]));

export function preferredDisplaySpace(){
  return globalThis.matchMedia?.('(color-gamut: p3)').matches?'display-p3':'srgb';
}

// Raw data, masks and sRGB samples go to the browser as tagged sRGB ImageData.
export function imageDisplaySpace(space,canvasSpace){
  return hasWideGamut(space)&&canvasSpace==='display-p3'?'display-p3':'srgb';
}
export function displayColorCss(hex,space){
  if(!Object.hasOwn(toSRGB,space))return hex;
  const target=imageDisplaySpace(space,preferredDisplaySpace());
  const rgb=hex.slice(1).match(/../g).map(n=>parseInt(n,16));
  const display=new Uint8ClampedArray(4);
  writeDisplayRGB(display,[...rgb,255],space,false,target);
  const values=[...display.subarray(0,3)];
  return target==='display-p3'?'color(display-p3 '+values.map(v=>v/255).join(' ')+')':'rgb('+values.join(' ')+')';
}

export function setWorkingSwatch(input,space){
  if(!Object.hasOwn(toSRGB,space)){
    delete input.dataset.workingSpace;input.style.removeProperty('--working-swatch');return;
  }
  input.dataset.workingSpace=space;
  input.style.setProperty('--working-swatch',displayColorCss(input.value,space));
}
const decoders=new Map();
let encoded;
export function hasWideGamut(space){
  return Boolean(toSRGB[space])&&toSRGB[space]!==grayMatrix&&space!=='rec709'&&space!=='linear-srgb';
}

function outsideSRGB(m,r,g,b){
  for(let row=0;row<9;row+=3){
    const value=m[row]*r+m[row+1]*g+m[row+2]*b;
    // Ignore tiny excursions from rounding ICC matrix tags (signed 16.16).
    if(value<-.0002||value>1.0002)return true;
  }
  return false;
}

export function writeDisplayRGB(target,pixels,space,warnGamut=false,outputSpace='srgb'){
  const p3=outputSpace==='display-p3',m=(p3?toP3:toSRGB)[space];
  if(!m||p3&&space==='display-p3'&&!warnGamut){if(target!==pixels)target.set(pixels);return;}
  if(!encoded)encoded=Uint8Array.from({length:65536},(_,i)=>{
    const x=i/65535;
    return Math.round(255*(x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055));
  });
  if(!decoders.has(space))decoders.set(space,Float64Array.from({length:256},(_,i)=>{
    const x=i/255;
    if(space==='gray-g22')return x**2.2;
    if(space==='gray-linear'||space==='linear-srgb'||space==='acescg'||space==='aces2065-1')return x;
    if(space==='dci-p3')return x**2.6;
    if(space==='rec2020-g24')return x**2.4;
    if(space==='rec709'||space==='rec2020'){
      const a=space==='rec709'?.909912109375:.90966796875;
      return x<.081?x/4.5:(a*x+1-a)**(1/.45);
    }
    if(space==='adobe-rgb')return x**(563/256);
    if(space==='prophoto-rgb')return x<1/32?x/16:x**1.8;
    return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
  }));
  const linear=decoders.get(space);
  const byte=x=>encoded[Math.round(Math.max(0,Math.min(1,x))*65535)];
  for(let i=0;i<pixels.length;i+=4){
    const r=linear[pixels[i]],g=linear[pixels[i+1]],b=linear[pixels[i+2]];
    const red=m[0]*r+m[1]*g+m[2]*b,green=m[3]*r+m[4]*g+m[5]*b,blue=m[6]*r+m[7]*g+m[8]*b;
    const outside=warnGamut&&pixels[i+3]>0&&outsideSRGB(toSRGB[space],r,g,b);
    target[i]=outside?(p3?243:255):byte(red);
    target[i+1]=outside?(p3?177:173):byte(green);
    target[i+2]=outside?(p3?80:54):byte(blue);
    target[i+3]=pixels[i+3];
  }
}
