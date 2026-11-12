import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT} from '../store.mjs';
import {demoProjectId,nativeDemoProjectId} from '../demo-source.mjs';
import {sha256File} from '../file-fingerprint.mjs';
import {resolveSource,workspaceRoot} from '../workspace-paths.mjs';
import {nativeDemoTemplate} from './seed-native-demo.mjs';

async function copy(source,target){
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.copyFile(source,target);
}
async function write(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
}

export async function stageReleaseDemo(workspace,python){
  const output=path.join(workspace,'workbench/console'),inputs={};
  const native=await nativeDemoTemplate(python);
  async function stage(document,folder,id){
    const source=resolveSource(document.source);
    const filename=id===nativeDemoProjectId?'model.glb':'demo.blend';
    if(document.id!==id||document.revision!==0||source.bindingVersion!==2||
       source.reviewSource!==path.join(folder,filename))throw Error('示例模型登记文件无效');
    for(const [file,expected] of Object.entries(source.files)){
      const relative=path.relative(folder,file);
      if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))
        throw Error('示例模型输入越出生成目录');
      const digest=await sha256File(file);
      if(digest!==expected)throw Error('示例模型输入已改变：'+relative);
      const destination=path.relative(workspaceRoot,file);
      await copy(file,path.join(workspace,destination));
      inputs[destination.split(path.sep).join('/')]=digest;
    }
    const project=path.join(output,'seed/projects',id);
    await write(path.join(project,'project.json'),document);
    await write(path.join(project,'history.json'),{undo:[],redo:[]});
    return source;
  }
  const nativeFolder=path.join(ROOT,'.demo-native');
  const nativeSource=await stage(native,nativeFolder,nativeDemoProjectId);
  const topology=path.join(nativeFolder,'topology.json');
  const topologyDoc=JSON.parse(await fs.readFile(topology,'utf8'));
  if(topologyDoc.modelSha256!==nativeSource.files[nativeSource.reviewSource])
    throw Error('示例模型拓扑与登记模型不一致');
  const relative=path.relative(workspaceRoot,topology);
  await copy(topology,path.join(workspace,relative));
  inputs[relative.split(path.sep).join('/')]=await sha256File(topology);

  // Keep existing release bindings usable when building from a checkout with the previous sample.
  const legacyFolder=path.join(ROOT,'.demo');
  let legacy;
  try{legacy=JSON.parse(await fs.readFile(path.join(legacyFolder,'project.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;return inputs;}
  const source=await stage(legacy,legacyFolder,demoProjectId);
  const viewport=path.join(legacyFolder,'viewport');
  const metadata=JSON.parse(await fs.readFile(path.join(viewport,'metadata.json'),'utf8'));
  if(!metadata.uv_unchanged||metadata.source_sha256!==source.files[source.reviewSource])
    throw Error('旧版示例视口与登记模型不一致');
  const key=createHash('sha256').update(JSON.stringify([metadata.source_sha256,
    await sha256File(path.join(ROOT,'viewport_export.py')),source.material])).digest('hex').slice(0,32);
  for(const name of ['model.glb','metadata.json'])
    await copy(path.join(viewport,name),path.join(output,'seed/viewport',key,name));
  return inputs;
}
