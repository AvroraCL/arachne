import path from 'node:path';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {cyclesOptions} from './cycles-options.mjs';

const root=import.meta.dirname,origin='https://arachne-render.invalid';
const importMap={imports:{
  three:'/vendor/three/build/three.module.js',
  'three/addons/':'/vendor/three/examples/jsm/',
  'three/examples/jsm/':'/vendor/three/examples/jsm/',
  'three-gpu-pathtracer':'/vendor/three-gpu-pathtracer/build/index.module.js',
  'three-mesh-bvh':'/vendor/three-mesh-bvh/build/index.module.js'
}};

export function pathTraceOptions(raw){
  const {width,height,samples,camera,maxBounces=12,transparent=false,textureJobId,device='auto',fileFormat='PNG',bitDepth}=cyclesOptions(raw);
  if(textureJobId)throw Error('工程渲染使用冻结修订的贴图');
  return {width,height,samples,camera,maxBounces,transparent,device,fileFormat,bitDepth:fileFormat==='OPEN_EXR'?bitDepth:8};
}

export async function renderPathTrace(input,files,{signal,onSample,registerBrowser}){
  signal?.throwIfAborted();
  const browser=await chromium.launch({
    ...(process.env.ARACHNE_BROWSER?{executablePath:process.env.ARACHNE_BROWSER}:{}),
    args:['--enable-unsafe-swiftshader',...(input.settings.device==='cpu'?['--use-angle=swiftshader']:[])]
  });
  registerBrowser?.(browser);
  const close=()=>void browser.close().catch(()=>{});
  signal?.addEventListener('abort',close,{once:true});
  let expired=false;
  const timeout=setTimeout(()=>{expired=true;close();},30*60*1000);
  try{
    signal?.throwIfAborted();
    const page=await browser.newPage({serviceWorkers:'block'});
    const fault=Promise.withResolvers();
    page.on('console',message=>{
      if(message.type()==='error'&&message.text().includes('Shader Error'))
        fault.reject(Error(message.text()));
    });
    // The worker can only read the verified inputs and local modules for this job.
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      const name=url.pathname;
      if(name==='/')return route.fulfill({contentType:'text/html',body:
        '<!doctype html><meta charset="utf-8"><script type="importmap">'+JSON.stringify(importMap)+'</script>'});
      if(Object.hasOwn(files,name))return route.fulfill({path:files[name]});
      if(/^\/[\w-]+\.mjs$/.test(name))return route.fulfill({path:path.join(root,'public',name.slice(1)),contentType:'text/javascript'});
      if(/^\/vendor\/three\/(?:build|examples\/jsm)(?:\/[\w.-]+)+\.js$/.test(name)||
        /^\/vendor\/(?:three-gpu-pathtracer|three-mesh-bvh)\/build\/index\.module\.js$/.test(name))
        return route.fulfill({path:path.join(root,'node_modules',name.slice('/vendor/'.length)),contentType:'text/javascript'});
      return route.abort();
    });
    await page.exposeFunction('reportRenderSample',onSample);
    await page.goto(origin);
    const download=input.settings.fileFormat==='OPEN_EXR'?page.waitForEvent('download',{timeout:0}):null;
    const render=page.evaluate(async config=>{
      const {renderImage}=await import('/path-trace-image.mjs');
      return renderImage(config);
    },input);
    const [{png,...result},file]=await Promise.race([fault.promise,Promise.all([render,download])]);
    signal?.throwIfAborted();
    const exr=file?await fs.readFile(await file.path(),{signal}):null;
    return {...result,png:Buffer.from(png,'base64'),exr};
  }catch(error){
    signal?.throwIfAborted();
    if(expired)throw Error('路径追踪超过 30 分钟，请降低分辨率或采样数后重试');
    throw error;
  }finally{
    clearTimeout(timeout);
    signal?.removeEventListener('abort',close);
    await browser.close().catch(()=>{});
    registerBrowser?.(null);
  }
}
