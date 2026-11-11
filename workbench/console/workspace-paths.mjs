import {checkedRootAliases} from './release-paths.mjs';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

export const workspaceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const aliases=JSON.parse(fs.readFileSync(path.join(workspaceRoot,'workspace-paths.json'),'utf8'));
if(process.env.ARACHNE_PATH_ALIASES){const saved=JSON.parse(fs.readFileSync(process.env.ARACHNE_PATH_ALIASES,'utf8'));aliases.roots.push(...checkedRootAliases(saved.roots));}
// Resolve archived absolute paths against this checkout, never fall back to the old workspace.
export function workspacePath(value){
  const normalized=value.replaceAll('\\','/');
  for(const [old,target] of Object.entries(aliases.files||{}))if(normalized.toLowerCase()===old.toLowerCase())return path.join(workspaceRoot,target);
  for(const old of aliases.roots){
    if(normalized.toLowerCase()===old.toLowerCase())return workspaceRoot;
    if(normalized.toLowerCase().startsWith(old.toLowerCase()+'/')){
      const result=path.resolve(workspaceRoot,normalized.slice(old.length+1));
      if(!result.startsWith(workspaceRoot+path.sep))throw Error('登记路径越出工作区');
      return result;
    }
  }
  return value;
}
export function resolveSource(source){
  const result=structuredClone(source);
  for(const key of ['bundle','cacheRun','reviewSource','baseImage','finImage','finMapping','artwork','textLayout','materialRecord'])if(result[key])result[key]=workspacePath(result[key]);
  if(result.files)result.files=Object.fromEntries(Object.entries(result.files).map(([p,h])=>[workspacePath(p),h]));
  return result;
}

export function portableSource(source){
  const portable=value=>{
    const relative=path.relative(workspaceRoot,value);
    return relative&&!path.isAbsolute(relative)&&!relative.startsWith('..'+path.sep)&&relative!=='..'
      ?'arachne-package:/'+relative.split(path.sep).join('/'):value;
  };
  const result=structuredClone(source);
  for(const key of ['bundle','cacheRun','reviewSource','baseImage'])if(result[key])result[key]=portable(result[key]);
  if(result.files)result.files=Object.fromEntries(Object.entries(result.files).map(([file,digest])=>[portable(file),digest]));
  return result;
}
