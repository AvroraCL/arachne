import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import {checkRenderVisibility} from './public/render-visibility.mjs';

const cache=new Map(),running=new Set(),marker='ARACHNE_RENDER_OBJECTS ';
const worker=path.join(import.meta.dirname,'blender_render_visibility.py');

export function renderSceneObjects(doc){
  const source=doc.source.reviewSource,expected=doc.source.files[source],stat=fs.statSync(source);
  if(!/^[a-f0-9]{64}$/.test(expected))throw Error('工程源场景未登记');
  const key=JSON.stringify([source,expected,stat.size,stat.mtimeMs,stat.ctimeMs]);
  if(cache.has(key))return cache.get(key);
  const result=new Promise((resolve,reject)=>{
    const child=execFile(blenderExecutable(),blenderScriptArgs(worker,[source,expected]),
    {windowsHide:true,timeout:20000,maxBuffer:2*1024*1024},(error,stdout)=>{
      running.delete(child);
      if(error){reject(Error('无法读取 Blender 源场景的渲染物体'));return;}
      try{
        const raw=stdout.split(/\r?\n/).find(line=>line.startsWith(marker));
        const parsed=JSON.parse(raw?.slice(marker.length));
        if(parsed.sourceSha256!==expected)throw Error();
        resolve({sourceSha256:expected,visibility:checkRenderVisibility(parsed.visibility)});
      }catch{reject(Error('Blender 未返回有效的渲染物体列表'));}
    });
    running.add(child);
  });
  cache.set(key,result);
  while(cache.size>8)cache.delete(cache.keys().next().value);
  void result.catch(()=>{if(cache.get(key)===result)cache.delete(key);});
  return result;
}

export function stopRenderSceneObjects(){for(const child of running)child.kill();}
