export const SCENE_DEFAULTS=Object.freeze({background:'gradient',backgroundColor:'#292929',backgroundTop:'#484848',environment:'studio',environmentStrength:.35,lightStrength:1,rotation:0,exposure:0,ground:false,groundColor:'#4a4a4a',groundHeight:0,groundRoughness:.7,grid:true,samples:32,resolution:.65,denoise:true,bounces:6});
export function sceneOptions(raw={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('空间设置无效');
 for(const key of Object.keys(raw))if(!(key in SCENE_DEFAULTS))throw Error('未知空间设置：'+key);
 const value={...SCENE_DEFAULTS,...raw};
 for(const [key,choices] of [['background',['solid','gradient','transparent']],['environment',['studio','soft','daylight']]])if(!choices.includes(value[key]))throw Error('空间选项无效：'+key);
 for(const key of ['backgroundColor','backgroundTop','groundColor'])if(typeof value[key]!=='string'||!/^#[0-9a-f]{6}$/i.test(value[key]))throw Error('颜色格式无效');
 for(const [key,min,max] of [['environmentStrength',0,3],['lightStrength',0,4],['rotation',0,360],['exposure',-4,4],['groundHeight',-.5,.5],['groundRoughness',0,1],['samples',4,128],['resolution',.25,1],['bounces',2,12]])if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<min||value[key]>max)throw Error('空间数值超出范围：'+key);
 for(const key of ['samples','bounces'])if(!Number.isInteger(value[key]))throw Error('采样和反弹次数必须为整数');
 for(const key of ['ground','grid','denoise'])if(typeof value[key]!=='boolean')throw Error('空间开关无效：'+key);
 return value;
}

// Compare poses at a scale-relative subpixel tolerance; send the original pose to Cycles.
export function previewCameraKey(camera,radius=1){
 const base=Number.isFinite(radius)&&radius>0?radius:1;const scale=Math.max(1e-12,Math.min(base,camera.orthoHeight||base));
 const quantum=10**(Math.floor(Math.log10(scale))-7);
 const snap=n=>Math.round(n/quantum);
 return {projection:camera.projection,quantum,eye:camera.eye.map(snap),target:camera.target.map(snap),up:camera.up.map(n=>Math.round(n*1e7)),fov:Math.round(camera.fov*1e6),orthoHeight:snap(camera.orthoHeight)};
}

export function previewKeysEqual(a,b){
 if(a===b)return true;if(!a||!b)return false;
 try{const x=JSON.parse(a),y=JSON.parse(b);if(x.context!==y.context||JSON.stringify(x.size)!==JSON.stringify(y.size)||JSON.stringify(x.scene)!==JSON.stringify(y.scene))return false;
 const c=x.camera,d=y.camera;if(c.projection!==d.projection)return false;
 const q=Math.max(c.quantum,d.quantum)*2;
 const close=(u,v,e)=>Math.abs(u-v)<=e+Number.EPSILON*Math.max(Math.abs(u),Math.abs(v))*8;
 for(const k of ['eye','target'])for(let i=0;i<3;i++)if(!close(c[k][i]*c.quantum,d[k][i]*d.quantum,q))return false;
 for(let i=0;i<3;i++)if(Math.abs(c.up[i]-d.up[i])>2)return false;
 return Math.abs(c.fov-d.fov)<=2&&close(c.orthoHeight*c.quantum,d.orthoHeight*d.quantum,q);
 }catch{return false;}
}
