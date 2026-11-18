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

// Only pigment coverage and the color underneath it are baked into a mark's map.
export function surfaceMarkMapsChanged(before = {}, after = {}) {
  if (before === after) return false;
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[name], next = after[name];
    if (old?.mark?.coverage !== next?.mark?.coverage ||
        (next?.mark && old?.color !== next.color)) return true;
  }
  return false;
}

export function applySourceFactors(material,factors){
  if(!factors)return;
  if(material.userData.markApplied)material.color.set(0xffffff);
  else if(factors.color!==undefined)material.color.set(factors.color);
  if('metalness' in material){
    if(factors.metallic!==undefined)material.metalness=factors.metallic;
    if(factors.roughness!==undefined)material.roughness=factors.roughness;
  }
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
export async function applySurfaceMarks(root,records,urlFor){
  const byName=new Map();
  root.traverse(node=>{if(node.isMesh)for(const material of [node.material].flat()){
    if(records?.[material.name]?.mark){if(!byName.has(material.name))byName.set(material.name,new Set());byName.get(material.name).add(material);}
  }});
  await Promise.all([...byName].map(async([name,materials])=>{
    const factors=records[name],image=await new THREE.ImageLoader().loadAsync(urlFor(factors.mark.coverage));
    for(const material of materials){
      if(material.map)throw Error('附属材质标记当前支持纯色底材：'+name);
      material.userData.sourceBaseColor='#'+material.color.getHexString();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext('2d');ctx.fillStyle=factors.color||'#'+material.color.getHexString();ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,0);material.map=new THREE.CanvasTexture(canvas);material.map.flipY=false;
      material.map.colorSpace=THREE.SRGBColorSpace;material.color.set(0xffffff);material.userData.markApplied=true;
    }
  }));
}
