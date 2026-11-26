import {projectTone} from './path-trace-lighting.mjs';
import {renderAppearanceDefaults} from './render-appearance.mjs';

const transforms=new WeakMap();
const contrastByLook={'AgX - Medium High Contrast':1.2,'AgX - Medium Low Contrast':.8};
const displayCode=`
  uniform float arachneInverseGamma;
  uniform float arachneContrast;
  vec3 arachneDisplayLook(vec3 linearColor) {
    if (arachneInverseGamma == 1. && arachneContrast == 1.) return linearColor;
    // Apply the look in the same reference space on every monitor and export.
    // Extend the transfer curves through zero to retain out-of-sRGB colors.
    vec3 encoded = sign(linearColor) * sRGBTransferOETF(vec4(abs(linearColor), 1.)).rgb;
    vec3 adjusted = sign(encoded) * pow(abs(encoded), vec3(arachneInverseGamma));
    adjusted = .5 + (adjusted - .5) * arachneContrast;
    return sign(adjusted) * sRGBTransferEOTF(vec4(abs(adjusted), 1.)).rgb;
  }
`;

export function setPathTraceDisplay(material,appearance=renderAppearanceDefaults){
  let uniforms=transforms.get(material);
  if(!uniforms){
    uniforms={arachneInverseGamma:{value:1},arachneContrast:{value:1}};
    const shader=material.fragmentShader;
    const anchor='return linearToOutputTexel( res );';
    if(!shader.includes(anchor))throw Error('路径追踪显示着色器不兼容');
    Object.assign(material.uniforms,uniforms);
    material.fragmentShader=displayCode+shader.replace(anchor,`
      res.rgb = arachneDisplayLook(res.rgb);
      ${anchor}`);
    material.needsUpdate=true;
    transforms.set(material,uniforms);
  }
  uniforms.arachneInverseGamma.value=1/appearance.gamma;
  uniforms.arachneContrast.value=contrastByLook[appearance.look]??1;
}

export function drawPathTrace(engine,renderer,appearance){
  const {toneMapping,toneMappingExposure}=renderer;
  setPathTraceDisplay(engine._quad.material,appearance||renderAppearanceDefaults);
  if(appearance)Object.assign(renderer,projectTone(appearance));
  try{engine.renderSample();}
  finally{Object.assign(renderer,{toneMapping,toneMappingExposure});}
}

export function completedPathTraceTarget(engine){
  const target=engine.target,pair=engine._pathTracer?._blendTargets;
  // Version 0.0.24 exposes the first alpha buffer even on even passes.
  return pair?.[1]===target&&Number.isInteger(engine.samples)&&engine.samples%2===0?pair[0]:target;
}
