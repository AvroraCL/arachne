import * as THREE from 'three';
import {liveStride} from './paint-channels.mjs';

// Display-only alternate. The imported PBR material remains available unchanged.
export function createUnlitMaterial(source) {
  const material = new THREE.MeshBasicMaterial({
    color: source.color.clone(),
    map: source.map,
    alphaMap: source.alphaMap,
    side: source.side,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
    alphaHash: source.alphaHash,
    depthWrite: source.depthWrite,
    vertexColors: source.vertexColors,
    toneMapped: false
  });
  material.name = source.name;
  material.userData = {...source.userData};
  return material;
}

// Match the painted channel readout: scalar and tangent-space values are display
// bytes; emissive textures and factors already multiply in linear light.
const sourceSamples = {
  color:'diffuse * texel.rgb',
  roughness:'vec3(diffuse.r * texel.g)',
  metallic:'vec3(diffuse.r * texel.b)',
  ao:'vec3(mix(1.0, texel.r, diffuse.r))',
  alpha:'vec3(diffuse.r * texel.a)',
  height:'vec3(diffuse.r * texel.r)',
  normal:'normalSample',
  emission:'diffuse * texel.rgb'
};

function compileSourceChannel(shader) {
  const channel=this.defines?.ARACHNE_SOURCE_CHANNEL;
  if (!channel) return;
  const readNormal=channel==='normal' ? `
    vec3 normalSample = vec3(0.5, 0.5, 1.0);
    #ifdef USE_MAP
      vec3 tangentNormal = (texel.rgb * 2.0 - 1.0) * vec3(diffuse.rr, 1.0);
      if (dot(tangentNormal, tangentNormal) > 0.0)
        normalSample = normalize(tangentNormal) * 0.5 + 0.5;
    #endif` : '';
  const vertexFactor=channel==='color' ? `
    #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
      value *= vColor.rgb;
    #endif` : channel==='alpha' ? `
    #ifdef USE_COLOR_ALPHA
      value *= vColor.a;
    #endif` : '';
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
    vec4 texel = vec4(1.0);
    #ifdef USE_MAP
      texel = texture2D(map, vMapUv);
    #endif
    ${readNormal}
    vec3 value = ${sourceSamples[channel]};
    ${vertexFactor}
    diffuseColor.rgb = ${channel==='emission'||channel==='color'?'value':'sRGBTransferEOTF(vec4(value, 1.0)).rgb'};
  `).replace('#include <color_fragment>','');
}

export function inspectSourceChannel(display,base,patch,channel) {
  // The caller has restored the ordinary display factors, maps and alpha first.
  const inspect=Object.hasOwn(sourceSamples,channel);
  display.vertexColors=base.vertexColors && (!inspect || channel==='alpha' || channel==='color');
  if (!inspect) {
    if (display.defines) delete display.defines.ARACHNE_SOURCE_CHANNEL;
    return;
  }
  display.onBeforeCompile=compileSourceChannel;
  display.defines??={};
  display.defines.ARACHNE_SOURCE_CHANNEL=channel;
  display.alphaMap=null;
  switch (channel) {
    case 'roughness':
      display.map=base.roughnessMap;display.color.setScalar(patch?.roughness??base.roughness??1);break;
    case 'metallic':
      display.map=base.metalnessMap;display.color.setScalar(patch?.metallic??base.metalness??0);break;
    case 'ao':
      display.map=base.aoMap;display.color.setScalar(base.aoMapIntensity??1);break;
    case 'alpha': {
      const usesAlpha=base.transparent||display.alphaTest>0||display.alphaHash;
      display.map=usesAlpha?base.map:null;display.color.setScalar(usesAlpha?base.opacity:1);
      display.vertexColors&&=usesAlpha;break;
    }
    case 'height':
      display.map=base.bumpMap;display.color.setScalar(base.bumpMap?1:.5);break;
    case 'normal':
      display.map=base.normalMap;display.color.setScalar(base.normalScale?.x??1);break;
    case 'emission':
      display.map=base.emissiveMap;
      if(base.emissive)display.color.copy(base.emissive).multiplyScalar(base.emissiveIntensity);
      else display.color.setScalar(0);
  }
}

// Only pigment coverage and the color underneath it are baked into a mark's map.
export function sameSurfaceMarkPixels(a,b) {
  return a?.mark?.coverage === b?.mark?.coverage && (!a?.mark || a.color === b.color);
}

export function applySourceFactors(material,factors,marked=material.userData.markApplied){
  if(!factors)return;
  if(marked)material.color.set(0xffffff);
  else if(factors.color!==undefined)material.color.set(factors.color);
  if('metalness' in material){
    if(factors.metallic!==undefined)material.metalness=factors.metallic;
    if(factors.roughness!==undefined)material.roughness=factors.roughness;
  }
  if(material.isMeshPhysicalMaterial&&factors.transmission!==undefined)material.transmission=factors.transmission;
}

// The inspection texture uses the same sRGB decoding and linear filtering as
// the expanded grayscale display. Select the component before vertex colors.
export const scalarInspectionComponent={metallic:'bbb',roughness:'ggg',ao:'rrr'};
export function installScalarInspection(material){
  const compile=material.onBeforeCompile;
  material.onBeforeCompile=function(shader,renderer){
    compile.call(this,shader,renderer);
    const component=this.defines?.PAINT_INSPECT_COMPONENT;
    if(component)shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',
      'diffuseColor.rgb = diffuseColor.'+component+';\n#include <color_fragment>');
  };
}

export function livePaintTextureSpaces(channels) {
  const spaces = {color: THREE.SRGBColorSpace, scalar: THREE.NoColorSpace};
  if (channels.includes('normal')) spaces.normal = THREE.NoColorSpace;
  if (channels.includes('height') || channels.includes('alpha')) spaces.detail = THREE.NoColorSpace;
  if (channels.includes('emission')) spaces.emission = THREE.SRGBColorSpace;
  return spaces;
}

export function updateLivePaintTextures(current, size, channels, create) {
  const maps = {};
  let changed = !current;
  for (const [key,space] of Object.entries(livePaintTextureSpaces(channels))) {
    const previous = current?.[key];
    if (previous?.image.width === size) maps[key] = previous;
    else {
      maps[key] = create(space);
      changed = true;
    }
  }
  for (const [key,map] of Object.entries(current || {})) {
    if (maps[key] === map) continue;
    map.dispose();
    changed = true;
  }
  return {maps,changed};
}

// Roughness/metalness/AO share one linear map. Height and opacity share another.
export function fillLivePaintTextures(pixels, size, maps, solo = null) {
  const color = maps.color.image.data, scalar = maps.scalar.image.data;
  const detail = maps.detail?.image.data, normal = maps.normal?.image.data, emission = maps.emission?.image.data;
  const stride = liveStride(pixels,size), extended = stride === 15;
  for (let i = 0, j = 0; i < pixels.length; i += stride, j += 4) {
    color[j] = solo ? solo[j] : pixels[i];
    color[j+1] = solo ? solo[j+1] : pixels[i+1];
    color[j+2] = solo ? solo[j+2] : pixels[i+2];
    color[j+3] = 255;
    scalar[j] = extended ? pixels[i+14] : 255;
    scalar[j+1] = pixels[i+4];
    scalar[j+2] = pixels[i+3];
    scalar[j+3] = 255;
    if (detail) {
      detail[j] = extended ? pixels[i+9] : 128;
      detail[j+1] = extended ? pixels[i+13] : 255;
      detail[j+3] = 255;
    }
    if (normal) {
      normal[j] = extended ? pixels[i+6] : 128;
      normal[j+1] = extended ? pixels[i+7] : 128;
      normal[j+2] = extended ? pixels[i+8] : 255;
      normal[j+3] = 255;
    }
    if (emission) {
      emission[j] = extended ? pixels[i+10] : 0;
      emission[j+1] = extended ? pixels[i+11] : 0;
      emission[j+2] = extended ? pixels[i+12] : 0;
      emission[j+3] = 255;
    }
  }
}

// A source-material mark uses a transparent, original-UV pigment map. Preserve
// the source roughness, metalness and optical settings on the same material.
export function compositeSurfaceMark(image,color){
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(image,0,0);
  const map=new THREE.CanvasTexture(canvas);map.flipY=false;map.colorSpace=THREE.SRGBColorSpace;
  return map;
}

export async function applySurfaceMarks(root,records,urlFor){
  const byName=new Map();
  root.traverse(node=>{if(node.isMesh)for(const material of [node.material].flat()){
    if(records?.[material.name]?.mark){if(!byName.has(material.name))byName.set(material.name,new Set());byName.get(material.name).add(material);}
  }});
  await Promise.all([...byName].map(async([name,materials])=>{
    const factors=records[name],image=await new THREE.ImageLoader().loadAsync(urlFor(factors.mark.coverage));
    for(const material of materials){
      if(material.map)throw Error('附属材质标记当前支持纯色底材：'+name);
      material.map=compositeSurfaceMark(image,factors.color||'#'+material.color.getHexString());
      material.color.set(0xffffff);material.userData.markApplied=true;
    }
  }));
}
