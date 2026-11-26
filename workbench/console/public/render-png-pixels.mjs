import * as THREE from 'three';
import {completedPathTraceTarget} from './path-trace-display.mjs';
import {linearSRGBToWorkingMatrix} from './image-display-rgb.mjs';
import {projectTone} from './path-trace-lighting.mjs';

// Run the output-primary conversion before the look and quantization. Only
// sRGB and Display P3 share the sRGB display curve.
export function setPngOutputSpace(material,space){
  if(!space||space==='srgb')return;
  const curves={
    'display-p3':'sRGBTransferOETF(vec4(c,1.)).rgb',
    'adobe-rgb':'pow(c,vec3(256./563.))',
    'prophoto-rgb':'mix(16.*c,pow(c,vec3(1./1.8)),greaterThanEqual(c,vec3(1./512.)))',
    rec2020:'mix(4.5*c,(pow(c,vec3(.45))-.09033203125)/.90966796875,greaterThanEqual(c,vec3(.018)))'
  };
  material.uniforms.arachneOutputMatrix={value:new THREE.Matrix3().set(...linearSRGBToWorkingMatrix(space))};
  material.fragmentShader=`uniform mat3 arachneOutputMatrix;
    vec4 arachneOutputTexel(vec4 rgba){
      vec3 c=max(arachneOutputMatrix*rgba.rgb,0.);
      return vec4(${curves[space]},rgba.a);
    }
    #define linearToOutputTexel arachneOutputTexel
    `+material.fragmentShader;
  material.needsUpdate=true;
}

// Read straight, display-transformed samples directly from the final path-trace
// texture. Packing the high and low bytes separately avoids an 8-bit canvas copy.
export async function downloadPngScanlines(renderer,engine,settings,region,appearance){
  const {width,height,bitDepth}=settings,wide=bitDepth===16;
  const [left,top,right,bottom]=region?.pixels??[0,0,width,height];
  const [outWidth,outHeight]=region?.output??[width,height];
  const sourceX=region?.crop?left:0,sourceTop=region?.crop?top:0;
  const quad=engine._quad,material=quad.material,anchor='#include <premultiplied_alpha_fragment>';
  if(!material.fragmentShader.includes(anchor))throw Error('路径追踪输出着色器不兼容');
  const bytesPerPixel=wide?8:4;
  const stripHeight=Math.min(64,outHeight);
  const high=new Uint8Array(outWidth*stripHeight*4),low=wide?new Uint8Array(high.length):null;
  material.uniforms.map.value=completedPathTraceTarget(engine).texture;
  material.uniforms.arachneLowByte={value:false};
  material.fragmentShader='uniform bool arachneLowByte;\n'+material.fragmentShader.replace(anchor,`
    gl_FragColor.a = ${settings.transparent?'gl_FragColor.a':'1.0'};
    if (gl_FragColor.a <= 0.0) gl_FragColor.rgb = vec3(0.0);
    vec4 code = floor(clamp(gl_FragColor,0.0,1.0)*${wide?'65535.0':'255.0'}+0.5);
    gl_FragColor = ${wide?'(arachneLowByte ? mod(code,256.0) : floor(code/256.0))':'code'} / 255.0;
  `);
  material.blending=THREE.NoBlending;material.premultipliedAlpha=false;material.needsUpdate=true;
  Object.assign(renderer,projectTone(appearance));
  renderer.setRenderTarget(null);renderer.setScissorTest(true);renderer.autoClear=false;
  const gl=renderer.getContext(),deflate=new CompressionStream('deflate'),writer=deflate.writable.getWriter();
  const blob=new Response(deflate.readable).blob();
  for(let row=0;row<outHeight;row+=stripHeight){
    const rows=Math.min(stripHeight,outHeight-row),sy=height-sourceTop-row-rows;
    renderer.setScissor(sourceX,sy,outWidth,rows);
    const draw=(bytes,lowByte)=>{
      material.uniforms.arachneLowByte.value=lowByte;
      quad.render(renderer);
      gl.readPixels(sourceX,sy,outWidth,rows,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    };
    draw(high,false);
    if(wide)draw(low,true);
    if(gl.isContextLost())throw Error('读取 PNG 时图形设备连接中断');
    const stride=1+outWidth*bytesPerPixel,scanlines=new Uint8Array(stride*rows);
    for(let y=0;y<rows;y++){
      let dest=y*stride+1,src=(rows-y-1)*outWidth*4;
      const maskedRow=sourceTop+row+y<top||sourceTop+row+y>=bottom;
      for(let x=0;x<outWidth;x++){
        const outside=maskedRow||sourceX+x<left||sourceX+x>=right;
        for(let c=0;c<4;c++,src++){
          const blank=c===3&&!settings.transparent?255:0;
          scanlines[dest++]=outside?blank:high[src];
          if(wide)scanlines[dest++]=outside?blank:low[src];
        }
      }
      // PNG Sub filtering is bytewise and uses the original previous pixel.
      for(let i=dest-1;i>=y*stride+1+bytesPerPixel;i--)scanlines[i]-=scanlines[i-bytesPerPixel];
      scanlines[y*stride]=1;
    }
    await writer.write(scanlines);
  }
  await writer.close();
  const anchorElement=document.createElement('a');
  anchorElement.href=URL.createObjectURL(await blob);anchorElement.download='render-scanlines.zlib';anchorElement.click();
}
