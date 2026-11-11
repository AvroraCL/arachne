import fs from 'node:fs/promises';
import path from 'node:path';
import {userRoot} from './release-runtime.mjs';
import {APP_VERSION} from '../public/app-version.mjs';
try{
  const state=JSON.parse(await fs.readFile(path.join(userRoot,'current-server.json'),'utf8')),url=new URL(state.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)throw Error('无效的本机工作台地址');
  const build=JSON.parse(await fs.readFile(path.resolve(import.meta.dirname,'../../../../build-info.json'),'utf8'));
  if(build.version!==APP_VERSION||typeof build.buildId!=='string'||!/^[a-f0-9-]{36}$/i.test(build.buildId))throw Error('应用构建标识无效');
  const response=await fetch(url.origin+'/api/health',{signal:AbortSignal.timeout(2000)}),health=response.ok&&await response.json();
  if(!health||health.version!==APP_VERSION||health.buildId!==build.buildId)throw Error('运行中的工作台与 MCP 构建不一致');
  process.env.ARACHNE_PORT=url.port;
  await import('../paint-mcp.mjs');
}catch(error){process.stderr.write('请先启动阿拉克涅工作台。'+error.message+'\n');process.exitCode=1;}
