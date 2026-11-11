import {cyclesFormats} from './cycles-limits.mjs';

export const cyclesFormatLabel=format=>cyclesFormats[format]?.label??'PNG';

export function showRenderDownload(anchor,job,projectName){
  const {label,extension}=job.outputUrl?cyclesFormats.OPEN_EXR:cyclesFormats.PNG;
  anchor.textContent='下载 '+label;
  anchor.href=job.outputUrl||job.renderUrl;
  anchor.download=projectName.replace(/[\\/:*?"<>|]+/g,'-')+'-r'+job.revision+(job.render?'-PathTracing.':'-Cycles.')+extension;
}

export function showRenderPassDownload(anchor,job){
  anchor.hidden=!job?.passesUrl;
  if(job?.passesUrl){
    anchor.href=job.passesUrl;
    anchor.download='Cycles-r'+job.revision+'-Passes.exr';
  }else anchor.removeAttribute('href');
}
