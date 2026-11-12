import {cyclesFormats} from './cycles-limits.mjs';

export const cyclesFormatLabel=format=>cyclesFormats[format]?.label??'PNG';

export function renderDownloadFilename(job,projectName){
  const {extension}=job.outputUrl?cyclesFormats.OPEN_EXR:cyclesFormats.PNG;
  const clean=name=>name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g,'-').trim().replace(/[. ]+$/,'');
  if(job.renderBookmark){
    const project=clean(projectName).slice(0,36)||'Arachne',camera=clean(job.renderBookmark.name).slice(0,30)||'Camera';
    return `${project}-${camera}-r${job.revision}-${job.id.slice(0,8)}.${extension}`;
  }
  return clean(projectName)+'-r'+job.revision+(job.render?'-PathTracing.':'-Cycles.')+extension;
}

export function showRenderDownload(anchor,job,projectName){
  const {label}=job.outputUrl?cyclesFormats.OPEN_EXR:cyclesFormats.PNG;
  anchor.textContent='下载 '+label;
  anchor.href=job.outputUrl||job.renderUrl;
  anchor.download=renderDownloadFilename(job,projectName);
}

export function showRenderPassDownload(anchor,job){
  anchor.hidden=!job?.passesUrl;
  if(job?.passesUrl){
    anchor.href=job.passesUrl;
    anchor.download='Cycles-r'+job.revision+'-Passes.exr';
  }else anchor.removeAttribute('href');
}
