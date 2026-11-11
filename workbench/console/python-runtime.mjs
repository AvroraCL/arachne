import {existsSync} from 'node:fs';
import path from 'node:path';

export const windowsVenv=path.resolve(import.meta.dirname,'../../.venv');
export const windowsVenvPython=path.join(windowsVenv,'Scripts','python.exe');

export function pythonExecutable(){
  if(process.env.ARACHNE_PYTHON)return process.env.ARACHNE_PYTHON;
  if(process.platform==='win32')return existsSync(windowsVenvPython)?windowsVenvPython:'python.exe';
  return 'python3';
}
