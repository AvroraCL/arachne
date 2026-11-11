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
