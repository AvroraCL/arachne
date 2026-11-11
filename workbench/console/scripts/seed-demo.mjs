import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {blenderExecutable,blenderScriptArgs} from '../blender-runtime.mjs';
import {demoProjectId} from '../demo-source.mjs';
import {atomic,DATA,ROOT,hash,projectDir} from '../store.mjs';
import {portableSource,resolveSource,workspaceRoot} from '../workspace-paths.mjs';

const demo=path.join(ROOT,'.demo');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const tool=name=>path.join(ROOT,'../tools',name);
const canonical=file=>'arachne-package:/'+path.relative(workspaceRoot,file).split(path.sep).join('/');
function blender(script,args){
  execFileSync(blenderExecutable(),blenderScriptArgs(script,args),{stdio:'inherit',timeout:180_000});
}

function generate(){
  const staging=fs.mkdtempSync(path.join(ROOT,'.demo-staging-'));
  try{
    blender(path.join(import.meta.dirname,'generate-demo.py'),[staging]);
    const cameras={center:[0,0,0],views:{top:{right:[1,0,0],up:[0,1,0],dir:[0,0,1],span:6,cam_loc:[0,0,12]}}};
    const config={model:path.join(staging,'demo.blend'),camera_file:path.join(staging,'guides/cameras.json'),
      resolution:4096,uv_layer:'active',normal_policy:'as_is',exclude_contains:[],
      projection_exclude_objects:['Cover'],projection_exclude_regions:[],projection_exclude_materials:[],
      min_projection_cos:.2,guide:{facing_power:3},designs:{top:{image:path.join(staging,'base.png'),flip_u:false,flip_v:false}},
      mode:'baseline',angle_margin:.08,overlap_policy:'strict',grazing_cos:.2};
    atomic(path.join(staging,'guides/cameras.json'),cameras);
    atomic(path.join(staging,'guides/resolved_config.json'),{...config,resolution:512});
    atomic(path.join(staging,'cache/resolved_config.json'),config);
    blender(tool('prepare_guides.py'),[path.join(staging,'guides')]);
    blender(tool('geometry.py'),[path.join(staging,'cache')]);
    const guide=read(path.join(staging,'guides/report.json'));
    const geometry=read(path.join(staging,'cache/geometry_report.json'));
    if(!guide.uv_unchanged||!geometry.uv_unchanged||guide.uv_before_sha256!==geometry.uv_before_sha256||
      !geometry.visible_faces||!guide.views.top.receiver_hint_pixels||!guide.views.top.protected_visible_pixels)
      throw Error('示例模型 UV 或投影验证失败');
    const registered={...config,model:canonical(path.join(demo,'demo.blend')),camera_file:canonical(path.join(demo,'guides/cameras.json')),
      designs:{top:{...config.designs.top,image:canonical(path.join(demo,'base.png'))}}};
    atomic(path.join(staging,'guides/resolved_config.json'),{...registered,resolution:512});
    atomic(path.join(staging,'cache/resolved_config.json'),registered);
    atomic(path.join(staging,'viewport-input.json'),{source:config.model,material:'f_16xl',out:path.join(staging,'viewport')});
    blender(path.join(ROOT,'viewport_export.py'),[path.join(staging,'viewport-input.json')]);
    fs.unlinkSync(path.join(staging,'viewport-input.json'));
    const relative=['demo.blend','base.png','guides/cameras.json','guides/surfaces.npz','guides/resolved_config.json',
      'guides/top/raster.npz','guides/top/receiver.png','guides/top/protected.png','guides/top/silhouette.png','guides/top/facing.png',
      'cache/geometry_report.json','cache/resolved_config.json',
      ...fs.readdirSync(path.join(staging,'cache/mapping')).map(name=>'cache/mapping/'+name)];
    const files=Object.fromEntries(relative.map(file=>[path.join(demo,file),hash(path.join(staging,file))]));
    const source=portableSource({reviewSource:path.join(demo,'demo.blend'),baseImage:path.join(demo,'base.png'),
      bundle:path.join(demo,'guides'),cacheRun:path.join(demo,'cache'),material:'f_16xl',bindingVersion:2,files});
    const project={schemaVersion:1,id:demoProjectId,name:'示例模型 · PBR 涂装',revision:0,updated:new Date().toISOString(),
      canvas:{width:4096,height:4096},assets:{},fonts:{},layers:[],guides:{},source,workflowType:'pbr_paint',
      basecoat:{color:'#464f5e'},paint:{base:{color:'#464f5e',metallic:0,roughness:.46},layers:[],assets:{}}};
    atomic(path.join(staging,'project.json'),project);
    fs.renameSync(staging,demo);
  }finally{fs.rmSync(staging,{recursive:true,force:true});}
}

if(!fs.existsSync(demo))generate();
const template=read(path.join(demo,'project.json'));
const source=resolveSource(template.source);
for(const [file,digest] of Object.entries(source.files))
  if(hash(file)!==digest)throw Error('示例模型文件或缓存已改变，请在干净副本重新生成');
const meta=read(path.join(demo,'viewport/metadata.json'));
if(meta.source_sha256!==source.files[source.reviewSource]||!meta.uv_unchanged)throw Error('示例视口与源模型不一致');
const key=createHash('sha256').update(JSON.stringify([meta.source_sha256,hash(path.join(ROOT,'viewport_export.py')),source.material])).digest('hex').slice(0,32);
const cache=path.join(DATA,'viewport',key);
if(!fs.existsSync(cache)){
  fs.mkdirSync(path.dirname(cache),{recursive:true});
  fs.cpSync(path.join(demo,'viewport'),cache,{recursive:true,errorOnExist:true,force:false});
}
const folder=projectDir(demoProjectId);
if(!fs.existsSync(path.join(folder,'project.json'))){
  atomic(path.join(folder,'history.json'),{undo:[],redo:[]});
  atomic(path.join(folder,'project.json'),template);
}
console.log('示例模型已就绪。');
