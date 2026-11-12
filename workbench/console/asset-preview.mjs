import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pythonExecutable} from './python-runtime.mjs';

const run=promisify(execFile),cache=new Map(),pending=new Map();
let queue=Promise.resolve();
const program=[
  'import sys',
  'from PIL import Image',
  'with Image.open(sys.argv[1], formats=["PNG"]) as image:',
  ' image.thumbnail((128, 128), Image.Resampling.LANCZOS)',
  ' image.convert("RGBA").save(sys.stdout.buffer, format="PNG")'
].join('\n');

// Source images are immutable and addressed by their fingerprint. Keep only
// small decoded previews in memory and decode at most one 8K source at a time.
export function assetPreview(id,file){
  const hit=cache.get(id);
  if(hit){cache.delete(id);cache.set(id,hit);return Promise.resolve(hit);}
  if(pending.has(id))return pending.get(id);
  if(pending.size>=32)throw Object.assign(Error('贴图预览正在排队，请稍后重试'),{status:503});
  const task=queue.then(async()=>{
    const {stdout}=await run(pythonExecutable(),['-B','-X','utf8','-c',program,file],
      {encoding:'buffer',windowsHide:true,timeout:10000,maxBuffer:128*1024});
    cache.set(id,stdout);
    while(cache.size>96)cache.delete(cache.keys().next().value);
    return stdout;
  }).finally(()=>pending.delete(id));
  pending.set(id,task);
  queue=task.catch(()=>{});
  return task;
}
