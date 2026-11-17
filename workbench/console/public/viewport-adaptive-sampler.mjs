import {
  AlwaysStencilFunc, EqualStencilFunc, FloatType, NoBlending, ReplaceStencilOp,
  ShaderMaterial, WebGLRenderTarget
} from 'three';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';

const vertexShader=`
  void main() { gl_Position = vec4(position.xy, 0., 1.); }
`;

const accumulateFragment=`
  uniform sampler2D sampleImage;
  uniform sampler2D previousColor;
  uniform sampler2D previousStats;
  uniform bool firstSample;
  uniform float noiseThreshold;
  uniform float minimum;
  layout(location = 1) out vec4 stats;

  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec4 oldStats = firstSample ? vec4(0.) : texelFetch(previousStats, pixel, 0);
    vec4 oldColor = firstSample ? vec4(0.) : texelFetch(previousColor, pixel, 0);
    if (oldStats.w >= 2.) {
      gl_FragColor = oldColor;
      stats = oldStats;
      return;
    }

    // Accumulate premultiplied radiance and track coverage independently so
    // transparent and antialiased edges can continue taking samples.
    vec4 value = texelFetch(sampleImage, pixel, 0);
    value.rgb *= value.a;
    float count = oldStats.z + 1.;
    vec4 mean = oldColor + (value - oldColor) / count;
    const vec3 luma = vec3(.2126, .7152, .0722);
    float luminance = dot(value.rgb, luma);
    vec2 delta = vec2(luminance - dot(oldColor.rgb, luma), value.a - oldColor.a);
    vec2 residual = vec2(luminance - dot(mean.rgb, luma), value.a - mean.a);
    vec2 m2 = max(oldStats.xy + delta * residual, vec2(0.));
    float stable = 0.;
    if (count >= minimum) {
      vec2 error = sqrt(m2 / (count * (count - 1.)));
      if (error.x <= noiseThreshold * max(dot(mean.rgb, luma), .02)
          && error.y <= noiseThreshold) stable = oldStats.w + 1.;
    }
    gl_FragColor = mean;
    stats = vec4(m2, count, stable);
  }
`;

const resolveFragment=`
  uniform sampler2D meanImage;
  void main() {
    vec4 mean = texelFetch(meanImage, ivec2(gl_FragCoord.xy), 0);
    gl_FragColor = vec4(mean.rgb / max(mean.a, .00001), mean.a);
  }
`;

const activeFragment=`
  uniform sampler2D pixelStats;
  void main() {
    if (texelFetch(pixelStats, ivec2(gl_FragCoord.xy), 0).w >= 2.) discard;
    gl_FragColor = vec4(1.);
  }
`;

function pass(fragmentShader,uniforms){
  return new FullScreenQuad(new ShaderMaterial({
    vertexShader,fragmentShader,uniforms,
    depthTest:false,depthWrite:false,blending:NoBlending,toneMapped:false
  }));
}

// The pinned path tracer owns the camera, materials and scene BVH. The
// viewport supplies its own accumulation only while adaptive sampling is on.
export function createViewportAdaptiveSampler(engine,renderer){
  const full=engine._pathTracer;
  const material=full.material;
  const gl=renderer.getContext();
  const raw=new WebGLRenderTarget(1,1,{type:FloatType,depthBuffer:true,stencilBuffer:true});
  const resolved=new WebGLRenderTarget(1,1,{type:FloatType,depthBuffer:false});
  const moments=()=>new WebGLRenderTarget(1,1,{type:FloatType,count:2,depthBuffer:false});
  let previous=moments(),next=moments(),tile=0,query=null,converged=false,options=null;
  const accumulation=pass(accumulateFragment,{
    sampleImage:{value:raw.texture},previousColor:{value:null},previousStats:{value:null},
    firstSample:{value:true},noiseThreshold:{value:0},minimum:{value:3}
  });
  const resolve=pass(resolveFragment,{meanImage:{value:null}});
  const active=pass(activeFragment,{pixelStats:{value:null}});
  Object.assign(active.material,{
    colorWrite:false,stencilWrite:true,stencilFunc:AlwaysStencilFunc,stencilRef:1,stencilZPass:ReplaceStencilOp
  });
  const ray=new FullScreenQuad(material);
  const baseReset=full.reset.bind(full),baseUpdate=full.update.bind(full);

  function clearConvergence(){
    if(query)gl.deleteQuery(query);
    query=null;
    converged=false;
  }
  function poll(){
    if(query&&gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
      converged=!gl.getQueryParameter(query,gl.QUERY_RESULT);
      gl.deleteQuery(query);
      query=null;
    }
    return converged;
  }

  full.reset=()=>{
    baseReset();
    tile=0;
    clearConvergence();
  };
  full.update=()=>{
    if(!options){baseUpdate();return;}
    material.onBeforeRender();
    if(full.isCompiling||poll())return;

    const width=full.target.width,height=full.target.height;
    const tilesX=Math.min(width,full.tiles.x),tilesY=Math.min(height,full.tiles.y);
    if(tile===0){
      for(const target of [raw,resolved,previous,next])target.setSize(width,height);
      material.resolution.set(width,height);
      material.sobolTexture=full._sobolTarget.texture;
      material.stratifiedTexture.init(20,material.bounces+material.transmissiveBounces+5);
      material.stratifiedTexture.next();
      material.seed++;
    }
    const x=tile%tilesX,y=Math.floor(tile/tilesX);
    const left=Math.floor(x*width/tilesX),bottom=Math.floor(y*height/tilesY);
    raw.scissor.set(left,bottom,Math.floor((x+1)*width/tilesX)-left,Math.floor((y+1)*height/tilesY)-bottom);
    raw.scissorTest=true;
    const target=renderer.getRenderTarget(),autoClear=renderer.autoClear;
    const {blending,opacity,stencilWrite,stencilFunc,stencilRef,stencilWriteMask}=material;
    const completed=++tile===tilesX*tilesY;
    try{
      renderer.autoClear=false;
      renderer.setRenderTarget(raw);
      Object.assign(material,{
        blending:NoBlending,opacity:1,stencilWrite:full.samples>=options.minimum+1,
        stencilFunc:EqualStencilFunc,stencilRef:1,stencilWriteMask:0
      });
      ray.render(renderer);
      if(!completed)return;

      const uniforms=accumulation.material.uniforms;
      uniforms.previousColor.value=previous.texture;
      uniforms.previousStats.value=previous.textures[1];
      uniforms.firstSample.value=full.samples===0;
      uniforms.noiseThreshold.value=options.threshold;
      uniforms.minimum.value=options.minimum;
      renderer.setRenderTarget(next);
      accumulation.render(renderer);
      [previous,next]=[next,previous];
      resolve.material.uniforms.meanImage.value=previous.texture;
      renderer.setRenderTarget(resolved);
      resolve.render(renderer);
      full.samples++;
      tile=0;

      if(full.samples>=options.minimum+1){
        raw.scissorTest=false;
        renderer.setRenderTarget(raw);
        renderer.state.buffers.stencil.setMask(0xff);
        renderer.clear(false,false,true);
        active.material.uniforms.pixelStats.value=previous.textures[1];
        const startedQuery=!query&&gl.createQuery();
        if(startedQuery){
          query=startedQuery;
          gl.beginQuery(gl.ANY_SAMPLES_PASSED,query);
        }
        try{active.render(renderer);}
        finally{if(startedQuery)gl.endQuery(gl.ANY_SAMPLES_PASSED);}
      }
    }finally{
      Object.assign(material,{blending,opacity,stencilWrite,stencilFunc,stencilRef,stencilWriteMask});
      renderer.setRenderTarget(target);
      renderer.autoClear=autoClear;
    }
  };
  return {
    configure(nextOptions){
      if(options?.threshold===nextOptions?.threshold&&options?.minimum===nextOptions?.minimum)return;
      options=nextOptions;
      clearConvergence();
      engine.reset();
    },
    poll,
    image:()=>options?resolved:null,
    dispose(){
      clearConvergence();
      full.reset=baseReset;
      full.update=baseUpdate;
      for(const target of [raw,resolved,previous,next])target.dispose();
      for(const quad of [accumulation,resolve,active]){quad.material.dispose();quad.dispose();}
      ray.dispose();
    }
  };
}
