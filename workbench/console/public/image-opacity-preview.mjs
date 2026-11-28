import {canvasCoordinates} from './image-canvas-coordinates.mjs';
import {imageOpacityPlan} from './image-opacity-plan.mjs';

const vertex=`#version 300 es
out vec2 uv;
void main(){
  uv=vec2(gl_VertexID==1 ? 2.0 : 0.0,gl_VertexID==2 ? 2.0 : 0.0);
  gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
}`;

function fragment(planes,metadata){
  const sample=entry=>`plane(t${entry},xy,ivec4(${metadata[entry].box.join(',')}))`;
  const composite=planes.map(({mode,opacity},i)=>{
    if(!metadata[i])return '';
    const pixel=metadata[i].box?sample(i):'vec4(1.0)';
    if(mode==='invert')return `invertColor(result,${pixel}.r*${opacity.toFixed(8)});`;
    if(mode==='normal')return `{
      vec4 p=${pixel};
      if(p.a>0.0)result=p.a*vec4(linearRGB(p.rgb),1.0)+result*(1.0-p.a);
    }`;
    const blend={
      multiply:'b*s',
      screen:'b+s-b*s',
      overlay:'mix(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),step(0.5,b))'
    }[mode];
    return `{
      vec4 p=${pixel};
      if(p.a>0.0){
      vec3 s=linearRGB(p.rgb);
      vec3 b=result.a>0.0 ? result.rgb/result.a : vec3(0.0);
      vec3 mixed=${blend};
      result.rgb=result.rgb*(1.0-p.a) + p.a*(s*(1.0-result.a)+mixed*result.a);
      result.a=p.a+result.a*(1.0-p.a);
      }
    }`;
  }).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 uv;
uniform float opacity;
uniform vec3 fill;
out vec4 color;
${metadata.map((entry,i)=>entry?.box?`uniform sampler2D t${i};`:'').join('\n')}
vec3 linearRGB(vec3 c){
  return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(0.04045,c));
}
vec3 srgb(vec3 c){
  return mix(c*12.92,1.055*pow(max(c,0.0),vec3(1.0/2.4))-0.055,step(0.0031308,c));
}
vec4 plane(sampler2D tex,ivec2 xy,ivec4 box){
  ivec2 p=xy-box.xy;
  if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,box.zw)))return vec4(0.0);
  return texelFetch(tex,p,0);
}
void invertColor(inout vec4 result,float amount){
  if(result.a>0.0&&amount>0.0)
    result.rgb=mix(result.rgb,linearRGB(1.0-srgb(result.rgb/result.a))*result.a,amount);
}
void main(){
  ivec2 xy=ivec2(vec2(uv.x,1.0-uv.y)*4096.0);
  vec4 result=vec4(linearRGB(fill)*opacity,opacity);
  ${composite}
  color=vec4(result.a>0.0 ? srgb(result.rgb/result.a) : vec3(0.0),result.a);
}`;
}

function makeProgram(gl,source){
  const program=gl.createProgram();
  for(const [kind,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,source]]){
    const shader=gl.createShader(kind);
    gl.shaderSource(shader,code);gl.compileShader(shader);
    gl.attachShader(program,shader);gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(gl.getProgramParameter(program,gl.LINK_STATUS))return program;
  gl.deleteProgram(program);
  throw Error('无法创建不透明度预览着色器');
}

export function createImageOpacityPreview(canvas,onReady){
  const layer=canvas.ownerDocument.createElement('canvas');
  layer.className='document-opacity-preview';
  layer.hidden=true;layer.setAttribute('aria-hidden','true');
  canvas.after(layer);
  let gl,prepared,last,unavailable=false;
  function hide(){
    layer.hidden=true;
    canvas.classList.remove('document-opacity-source');
  }
  function clear(){
    hide();delete layer.dataset.ready;
    if(prepared){
      prepared.controller.abort();
      if(prepared.program)gl.deleteProgram(prepared.program);
      for(const texture of prepared.textures)gl.deleteTexture(texture);
    }
    prepared=last=null;
  }
  layer.addEventListener('webglcontextlost',()=>{
    unavailable=true;clear();
  });
  function align(){
    for(const prop of ['width','height','transform']){
      if(layer.style[prop]!==canvas.style[prop])layer.style[prop]=canvas.style[prop];
    }
  }
  function resize(){
    align();
    // Rasterize at the display's sample density from native source pixels.
    // Preserve 1:1 samples when zoom reaches actual pixels.
    const size=canvasCoordinates(canvas);
    const width=Math.max(1,Math.min(4096,Math.ceil(size.width*devicePixelRatio)));
    const height=Math.max(1,Math.min(4096,Math.ceil(size.height*devicePixelRatio)));
    if(layer.width!==width||layer.height!==height){layer.width=width;layer.height=height;}
  }
  async function prepare(state,job){
    const response=await fetch('/api/projects/'+state.id+'/paint/image-live',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:job.controller.signal,
      body:JSON.stringify({revision:state.revision,documentId:state.documentId,opacityLayer:state.opacityLayer,resolution:4096})
    });
    if(!response.ok||response.status===204)throw Error('无法准备不透明度交互预览');
    const bytes=await response.arrayBuffer();
    job.controller.signal.throwIfAborted();
    const length=new DataView(bytes).getUint32(0,true);
    const metadata=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,length)));
    const program=job.program=makeProgram(gl,fragment(job.plan.planes,metadata));
    let offset=4+length;
    for(const [i,entry] of metadata.entries()){
      if(!entry?.box)continue;
      const image=await createImageBitmap(new Blob([new Uint8Array(bytes,offset,entry.length)],{type:'image/png'}),
        {premultiplyAlpha:'none',colorSpaceConversion:'none'});
      offset+=entry.length;
      try{
        job.controller.signal.throwIfAborted();
        const texture=gl.createTexture();job.textures.push(texture);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
        gl.uniform1i(gl.getUniformLocation(program,'t'+i),i);
      }finally{image.close();}
    }
    job.controller.signal.throwIfAborted();
    gl.useProgram(program);
    gl.uniform3fv(gl.getUniformLocation(program,'fill'),job.plan.fill.slice(1).match(/../g).map(rgb=>parseInt(rgb,16)/255));
    job.opacity=gl.getUniformLocation(program,'opacity');
    // Allocate the display buffer and exercise the linked shader before input.
    resize();
    gl.viewport(0,0,layer.width,layer.height);
    gl.uniform1f(job.opacity,1);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.flush();
    job.ready=true;layer.dataset.ready='true';
    onReady();
  }
  function sync(state){
    if(unavailable)return;
    if(last?.doc===state.imageDocument&&last?.layer===state.opacityLayer&&last?.documentId===state.documentId&&
       last?.project===state.id&&last?.enabled===state.nativeCanvas&&last?.inspect===state.inspectMask)return;
    const plan=state.nativeCanvas&&!state.inspectMask&&imageOpacityPlan(state.imageDocument,state.opacityLayer);
    const key=plan&&JSON.stringify([state.id,state.documentId,state.opacityLayer,state.imageDocument.layers.map(l=>
      l.id===state.opacityLayer?{...l,opacity:1}:l)]);
    if(prepared?.key!==key){
      clear();
      if(key){
        gl??=layer.getContext('webgl2',{alpha:true,premultipliedAlpha:false,depth:false,antialias:false});
        if(!gl){unavailable=true;return;}
        const job=prepared={key,plan,controller:new AbortController(),textures:[]};
        void prepare(state,job).catch(error=>{
          if(prepared===job){console.warn(error.message);clear();}
        });
      }
    }
    last={doc:state.imageDocument,layer:state.opacityLayer,documentId:state.documentId,project:state.id,
      enabled:state.nativeCanvas,inspect:state.inspectMask};
  }
  function render(state,operation,baseReady){
    if(!prepared?.ready||!baseReady||operation?.action!=='updateLayer'||operation.layerId!==state.opacityLayer||
       Object.keys(operation.patch).length!==1||typeof operation.patch.opacity!=='number')return false;
    resize();
    gl.viewport(0,0,layer.width,layer.height);
    gl.useProgram(prepared.program);
    gl.uniform1f(prepared.opacity,operation.patch.opacity);
    gl.drawArrays(gl.TRIANGLES,0,3);
    layer.hidden=false;
    canvas.classList.add('document-opacity-source');
    return true;
  }
  function restore(state){
    if(layer.hidden)return;
    const value=state.imageDocument?.layers.find(item=>item.id===state.opacityLayer)?.opacity;
    render(state,{action:'updateLayer',layerId:state.opacityLayer,patch:{opacity:value}},true);
  }
  return {sync,render,restore,hide,clear,dispose(){clear();layer.remove();}};
}
