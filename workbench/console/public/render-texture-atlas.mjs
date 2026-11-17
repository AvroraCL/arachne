import * as THREE from 'three';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';

const MiB=1024**2;
function planRenderTextures(sizes,{maxEdge,maxLayers,width,height,software}){
  const budget=(software?512:1280)*MiB;
  if(sizes.length>maxLayers)throw Error('贴图数量超过当前设备支持的纹理层数');
  if(!sizes.length)return {atlas:[1,1],layers:[],reduced:false};
  // The tracer can allocate three RGBA32F buffers, a depth buffer and a canvas.
  const available=budget-width*height*64-64*MiB;
  if(available<sizes.length*8)throw Error('出图分辨率超出当前纹理内存预算，请降低输出尺寸');
  let cap=Math.min(maxEdge,Math.max(...sizes.flat()));
  while(true){
    const layers=sizes.map(([w,h])=>{
      const scale=Math.min(1,cap/Math.max(w,h));
      return [Math.max(1,Math.floor(w*scale)),Math.max(1,Math.floor(h*scale))];
    });
    const atlas=[Math.max(...layers.map(size=>size[0])),Math.max(...layers.map(size=>size[1]))];
    const bytes=4*(atlas[0]*atlas[1]*layers.length+layers.reduce((sum,[w,h])=>sum+w*h,0));
    if(bytes<=available)return {atlas,layers,reduced:layers.some(([w,h],i)=>w!==sizes[i][0]||h!==sizes[i][1])};
    cap=Math.max(1,Math.floor(cap*Math.min(.98,Math.sqrt(available/bytes))));
  }
}

function resizeTexture(source,width,height){
  if(source.isCompressedTexture||source.isDataTexture)throw Error('当前设备无法缩小此贴图格式，请降低出图尺寸或转换贴图');
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d');
  if(!context)throw Error('无法准备贴图缩小缓冲区');
  context.imageSmoothingQuality='high';
  context.drawImage(source.image,0,0,width,height);
  const texture=new THREE.CanvasTexture(canvas);
  texture.flipY=source.flipY;
  texture.colorSpace=source.colorSpace;
  texture.premultiplyAlpha=source.premultiplyAlpha;
  return texture;
}

// The pinned tracer stores material indices in a 2D array. Place each source
// at its own size inside a layer and wrap/filter within that occupied region.
export function useRenderTextureAtlas(engine,renderer,settings){
  const material=engine._pathTracer.material;
  const originalTexture=material.textures;
  const target=new THREE.WebGLArrayRenderTarget(1,1,1,{
    depthBuffer:false,wrapS:THREE.RepeatWrapping,wrapT:THREE.RepeatWrapping,
    minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter
  });
  const quad=new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms:{sourceImage:{value:null}},
    vertexShader:'varying vec2 uvCopy; void main(){ uvCopy=uv; gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader:'uniform sampler2D sourceImage; varying vec2 uvCopy; void main(){ gl_FragColor=texture2D(sourceImage,uvCopy); }',
    depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false
  }));
  const gl=renderer.getContext();
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  const device=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'';
  const maxLayers=Math.min(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),Math.max(0,renderer.capabilities.maxFragmentUniforms-96));
  const originalShader=material.fragmentShader;
  let plan={atlas:[1,1],layers:[],reduced:false},sources=[];
  target.texture.setTextures=(output,textures)=>{
    sources=textures.map(texture=>[texture.image?.width,texture.image?.height]);
    if(sources.some(size=>size.some(n=>!Number.isSafeInteger(n)||n<1)))throw Error('无法确定源贴图尺寸');
    const previous=output.getRenderTarget(),autoClear=output.autoClear;
    let maxEdge=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const limits={maxLayers,width:settings.width,height:settings.height,
      software:settings.device==='cpu'||/swiftshader|llvmpipe|software/i.test(device)};
    try{
      while(true){
        plan=planRenderTextures(sources,{...limits,maxEdge});
        target.setSize(...plan.atlas,Math.max(1,textures.length));
        output.setRenderTarget(target,0);
        const allocated=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
        output.setRenderTarget(previous);
        if(allocated)break;
        const edge=Math.max(...plan.atlas);
        if(gl.isContextLost()||edge<=1)throw Error('当前设备无法分配贴图缓存，请降低输出分辨率后重试');
        maxEdge=Math.max(1,Math.floor(edge/2));
      }
    }finally{output.setRenderTarget(previous);}
    if(textures.length){
      const marker='uniform sampler2DArray textures;';
      if(!originalShader.includes(marker)||!originalShader.includes('texture2D( textures,'))throw Error('当前渲染器无法配置贴图采样');
      material.uniforms.arachneTextureSizes={value:plan.layers.map(size=>new THREE.Vector2(...size))};
      material.fragmentShader=originalShader.replaceAll('texture2D( textures,','arachneSampleTexture(').replace(marker,`
        uniform sampler2DArray textures;
        uniform vec2 arachneTextureSizes[${textures.length}];
        vec4 arachneSampleTexture(vec3 coord) {
          ivec2 size = ivec2(arachneTextureSizes[int(coord.z)]);
          if (all(equal(size,textureSize(textures,0).xy))) return texture(textures,coord);
          vec2 pos = fract(coord.xy) * vec2(size) - .5;
          ivec2 lo = ivec2(floor(pos));
          ivec2 a = (lo + size) % size, b = (lo + 1) % size;
          vec2 f = fract(pos);
          int layer = int(coord.z);
          vec4 top = mix(texelFetch(textures,ivec3(a,layer),0),texelFetch(textures,ivec3(b.x,a.y,layer),0),f.x);
          vec4 bottom = mix(texelFetch(textures,ivec3(a.x,b.y,layer),0),texelFetch(textures,ivec3(b,layer),0),f.x);
          return mix(top,bottom,f.y);
        }`);
      material.needsUpdate=true;
    }
    try{
      output.autoClear=false;
      if(!textures.length){
        output.setRenderTarget(target,0);
        output.clearColor();
      }
      for(const [index,source] of textures.entries()){
        const [width,height]=plan.layers[index],size=sources[index];
        const texture=width===size[0]&&height===size[1]?source:resizeTexture(source,width,height);
        const min=texture.minFilter,mipmaps=texture.generateMipmaps;
        try{
          texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;
          target.viewport.set(0,0,width,height);
          output.setRenderTarget(target,index);
          quad.material.uniforms.sourceImage.value=texture;
          quad.render(output);
        }finally{
          texture.minFilter=min;texture.generateMipmaps=mipmaps;
          // The worker only samples the atlas after this upload.
          texture.dispose();
        }
      }
    }finally{
      quad.material.uniforms.sourceImage.value=null;
      output.setRenderTarget(previous);
      output.autoClear=autoClear;
    }
  };
  material.textures=target.texture;
  return {
    report:()=>({...plan,sources}),
    dispose(){material.textures=originalTexture;target.dispose();quad.material.dispose();quad.dispose();}
  };
}
