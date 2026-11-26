import {ColorManagement, LinearSRGBColorSpace, SRGBColorSpace} from 'three';
import {DisplayP3ColorSpace, DisplayP3ColorSpaceImpl} from 'three/addons/math/ColorSpaces.js';

// The pinned WebGLProgram multiplies RGB as a row vector. Keep the standard
// ICC matrices for CPU conversions (clear color, fog and uniforms), and supply
// their transposed product only when compiling our viewport's output shader.
const p3Output = 'arachne-display-p3-output';
ColorManagement.define({[p3Output]: DisplayP3ColorSpaceImpl});
const standardMatrix = ColorManagement._getMatrix;
ColorManagement._getMatrix = function(target, source, destination) {
  if (source === LinearSRGBColorSpace && destination === p3Output) {
    return target.multiplyMatrices(DisplayP3ColorSpaceImpl.fromXYZ, this.spaces[source].toXYZ).transpose();
  }
  return standardMatrix.call(this, target, source, destination);
};

// The final shader and the browser compositor must agree on the RGB primaries.
export function watchViewportColor(renderer, preference, onChange) {
  const media = matchMedia('(color-gamut: p3)');
  const gl = renderer.getContext();
  let current;
  function update() {
    const target = preference !== 'srgb' && media.matches && 'drawingBufferColorSpace' in gl
      ? p3Output : SRGBColorSpace;
    const previousBuffer = gl.drawingBufferColorSpace;
    if (renderer.outputColorSpace !== target) renderer.outputColorSpace = target;
    if (target === p3Output && gl.drawingBufferColorSpace !== DisplayP3ColorSpace) {
      renderer.outputColorSpace = SRGBColorSpace;
    }
    const space = renderer.outputColorSpace === p3Output ? DisplayP3ColorSpace : SRGBColorSpace;
    if (previousBuffer !== gl.drawingBufferColorSpace) {
      // Chromium can retain the previous color tag on an already presented
      // canvas. Reallocate its display buffer; the path-trace targets survive.
      renderer.domElement.width = renderer.domElement.width;
    }
    if (current !== space) {
      current = space;
      onChange(current);
    }
  }
  media.addEventListener('change', update);
  update();
  return {
    setPreference(value) { preference = value; update(); },
    dispose() { media.removeEventListener('change', update); }
  };
}
