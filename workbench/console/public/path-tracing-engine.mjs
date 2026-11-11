let backend;

export async function createPathTracingEngine(renderer){
  if(!renderer.extensions.has('EXT_color_buffer_float'))
    throw Error('当前图形设备不支持路径追踪所需的浮点颜色缓冲');
  backend??=import('three-gpu-pathtracer').catch(error=>{backend=null;throw error;});
  const library=await backend,engine=new library.WebGLPathTracer(renderer);
  engine.renderDelay=0;
  engine.fadeDuration=0;
  engine.minSamples=1;
  engine.rasterizeScene=false;
  return {engine,library};
}
