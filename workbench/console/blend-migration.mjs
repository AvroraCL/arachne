import fs from 'node:fs/promises';
import {copyFileSync,constants} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,DATA,atomic,forkProject,hash,list,projectDir,read} from './store.mjs';
import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import {pythonExecutable} from './python-runtime.mjs';
import {installGlbRegistration} from './model-registration.mjs';
import {verifyPaint} from './paint.mjs';
import {registeredViewportModel} from './viewport.mjs';
import {nativeModelSteps,validateModelState} from './model-binding.mjs';
import {surfaceBindingKey,validateSurfaceBindings} from './paint-surface-bindings.mjs';

const execute=promisify(execFile),active=new Map();
export const isLegacyPaint=doc=>doc.workflowType==='pbr_paint'&&doc.source.bindingVersion===2&&
  doc.source.format!=='glb'&&path.extname(doc.source.reviewSource).toLowerCase()==='.blend';
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const conflict=doc=>Object.assign(Error('旧工程在迁移期间发生修改，请重新迁移当前修订'),
  {status:409,currentRevision:doc.revision});

function rebind(snapshot,glb,topology,meta){
  const digest=meta.source_sha256;
  function bind(state){
    if(!state)return state;
    if(state.modelSha256!==meta.rawGlbSha256)
      throw Error('无法确认旧建模记录的网格编号；原工程未修改');
    const next={...state,binding:digest.slice(0,32),modelSha256:digest,
      nativeSteps:nativeModelSteps(glb,state.steps,topology)};
    validateModelState(next);return next;
  }
  if(snapshot.modeling)snapshot.modeling=bind(snapshot.modeling);
  if(!snapshot.paint.surfaceBindings)return;
  validateSurfaceBindings(snapshot.paint);
  const lookup=new Map(),bindings={};
  for(const [key,state] of Object.entries(snapshot.paint.surfaceBindings)){
    const next=bind(state),updated=surfaceBindingKey(next);
    lookup.set(key,updated);bindings[updated]=next;
  }
  for(const layer of snapshot.paint.layers)
    for(const item of [layer,...(layer.strokes||[]),...(layer.maskStrokes||[])])
      if(item.surfaceBinding!==undefined)item.surfaceBinding=lookup.get(item.surfaceBinding);
  snapshot.paint.surfaceBindings=bindings;
  validateSurfaceBindings(snapshot.paint);
}

async function migrate(doc,signal){
  await verifyPaint(doc,{signal});
  const {source}=doc,record=await json(path.join(source.cacheRun,'geometry_report.json'));
  const legacyUV=record.uv_before_sha256,sourceSha256=source.files[source.reviewSource];
  if(record.uv_unchanged!==true||!/^[a-f0-9]{64}$/.test(legacyUV)||record.uv_after_sha256!==legacyUV)
    throw Error('旧工程的原 UV 尚未通过登记校验');
  const hashes=new Set([doc.modeling,...Object.values(doc.paint.surfaceBindings||{})]
    .filter(Boolean).map(state=>state.modelSha256));
  if(hashes.size>1)throw Error('旧工程包含多个模型版本，无法安全迁移建模记录');
  const [baselineSha256]=hashes;
  let baseline;
  if(baselineSha256)try{
    const model=registeredViewportModel(doc);
    if(model.sha256===baselineSha256)baseline=model.file;
  }catch{}
  const scratch=await fs.mkdtemp(path.join(DATA,'.blend-migration-'));
  try{
    const converted=path.join(scratch,'converted'),staging=path.join(scratch,'registration');
    const input=path.join(scratch,'blend-input.json'),registration=path.join(scratch,'registration-input.json');
    const settings=await json(path.join(source.cacheRun,'resolved_config.json'));
    atomic(input,{source:source.reviewSource,out:converted,material:source.material,sourceSha256,legacyUV,settings,baselineSha256,baseline});
    try{
      await execute(blenderExecutable(),blenderScriptArgs(path.join(ROOT,'blend_migrate.py'),[input]),
        {cwd:ROOT,windowsHide:true,signal,timeout:10*60_000,maxBuffer:4*1024*1024});
    }catch(error){
      signal.throwIfAborted();
      const lines=(error.stderr||'').trim().split(/\r?\n/);
      const reason=lines.reverse().find(line=>line.startsWith('ValueError: '))?.slice(12);
      throw Error(reason||'旧模型转换失败。请确认本机 Blender 可用，原工程未修改。');
    }
    await fs.mkdir(staging);
    atomic(registration,{input:converted,out:staging,source,sourceSha256,base:doc.paint.base,ownerPid:process.pid});
    try{
      await execute(pythonExecutable(),['-X','utf8',path.join(ROOT,'model_migrate.py'),registration],
        {cwd:ROOT,windowsHide:true,signal,timeout:10*60_000,maxBuffer:256*1024});
    }catch(error){
      signal.throwIfAborted();
      throw Error(error.stderr?.trim().split(/\r?\n/).at(-1)||'无法登记迁移后的模型；原工程未修改');
    }
    const meta=await json(path.join(staging,'metadata.json'));
    const snapshot=structuredClone(doc);
    if(hashes.size){
      const glb=await fs.readFile(path.join(staging,'model.glb'));
      rebind(snapshot,JSON.parse(glb.toString('utf8',20,20+glb.readUInt32LE(12))),
        await json(path.join(staging,'topology.json')),meta);
    }
    const assets=Object.entries(snapshot.paint.assets);
    const current=read(doc.id);
    if(current.revision!==doc.revision)throw conflict(current);
    return await installGlbRegistration(staging,async native=>{
      signal.throwIfAborted();
      snapshot.source=native.source;
      snapshot.migration={version:1,projectId:doc.id,revision:doc.revision,legacyModelSha256:sourceSha256,legacyUvSha256:legacyUV};
      const latest=read(doc.id);
      if(latest.revision!==doc.revision)throw conflict(latest);
      return forkProject(doc.id,snapshot,doc.name.slice(0,94)+' · GLB',destination=>{
        for(const [id,asset] of assets){
          if(!/^[a-f0-9]{64}$/.test(id)||asset.file!=='paint-'+id+'.png')throw Error('旧工程素材登记无效');
          const original=path.join(projectDir(doc.id),'assets',asset.file);
          const file=path.join(destination,asset.file);
          copyFileSync(original,file,constants.COPYFILE_EXCL);
          if(hash(file)!==id)throw Error('迁移时涂装素材指纹变化');
        }
      });
    });
  }finally{await fs.rm(scratch,{recursive:true,force:true});}
}

export async function migrateBlendProject(doc){
  if(!isLegacyPaint(doc))throw Error('当前工程已经使用原生模型，或没有可迁移的旧模型登记');
  const pending=active.get(doc.id);
  if(pending){
    if(pending.revision===doc.revision)return pending.promise;
    throw Object.assign(Error('旧工程正在迁移，请稍后再试'),{status:409});
  }
  for(const item of list()){
    if(item.workflowType!=='pbr_paint')continue;
    const candidate=read(item.id),previous=candidate.migration;
    if(candidate.source.format==='glb'&&previous?.projectId===doc.id&&previous.revision===doc.revision)
      return candidate;
  }
  const controller=new AbortController();
  const promise=migrate(doc,controller.signal).finally(()=>active.delete(doc.id));
  active.set(doc.id,{controller,revision:doc.revision,promise});
  return promise;
}

export const hasBlendMigrations=()=>active.size>0;
export function stopBlendMigrations(){for(const {controller} of active.values())controller.abort();}
