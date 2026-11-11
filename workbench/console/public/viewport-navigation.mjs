import * as THREE from 'three';

// OrbitControls already turns ROTATE + Shift into PAN. Mapping Shift to
// MOUSE.PAN would invert it a second time and rotate instead.
export function configureNavigation(controls) {
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.mouseButtons = {LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null};
}

export function attachOrbitInput(canvas, getControls) {
  canvas.addEventListener('pointerdown', event => {
    const controls = getControls();
    controls.mouseButtons.MIDDLE = event.ctrlKey || event.metaKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
    controls.mouseButtons.LEFT = event.altKey ? (event.ctrlKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE) : null;
    canvas.focus({preventScroll: true});
  }, true);
}

export function navigationCommand(event) {
  const {code, ctrlKey, metaKey, altKey, shiftKey} = event;
  if (altKey || metaKey) return null;
  if (ctrlKey && code === 'Space' && !shiftKey) return 'maximize';
  if (shiftKey) return null;
  if (['Numpad1','Numpad3','Numpad7'].includes(code)) {
    return ({Numpad1:ctrlKey?'back':'front',Numpad3:ctrlKey?'left':'right',Numpad7:ctrlKey?'bottom':'top'})[code];
  }
  if (ctrlKey) return null;
  return ({Numpad5:'projection',NumpadDecimal:'focus',Home:'fit',KeyF:'focus',NumpadDivide:'local',NumpadAdd:'zoomIn',NumpadSubtract:'zoomOut',Numpad4:'orbitLeft',Numpad6:'orbitRight',Numpad8:'orbitUp',Numpad2:'orbitDown',Numpad9:'opposite',KeyH:'hide'})[code] || null;
}

const v = a => new THREE.Vector3(...a);
export function projectionCamera(data, ortho) {
  const next = structuredClone(data), target = v(data.target), offset = v(data.eye).sub(target);
  const tangent = Math.tan(THREE.MathUtils.degToRad(data.fov / 2));
  const height = data.projection === 'orthographic' ? data.orthoHeight : offset.length() * 2 * tangent;
  next.projection = ortho ? 'orthographic' : 'perspective';
  next.orthoHeight = height;
  if (!ortho) next.eye = target.add(offset.normalize().multiplyScalar(height / (2 * tangent))).toArray();
  return next;
}

export function alignedCamera(data, direction, up, ortho = true) {
  const next = projectionCamera(data, ortho), distance = v(next.eye).distanceTo(v(next.target));
  next.eye = v(next.target).add(v(direction).normalize().multiplyScalar(distance)).toArray();
  next.up = [...up];
  return next;
}

export function movedCamera(data, command, amount = 1, height = 1) {
  const next = structuredClone(data), target = v(data.target), offset = v(data.eye).sub(target);
  const up = v(data.up).normalize(), forward = offset.clone().normalize();
  const right = new THREE.Vector3().crossVectors(up, forward).normalize();
  const screenUp = new THREE.Vector3().crossVectors(forward, right).normalize();
  if (command === 'pan') {
    const span = data.projection === 'orthographic' ? data.orthoHeight : offset.length()*2*Math.tan(THREE.MathUtils.degToRad(data.fov/2));
    const shift = right.multiplyScalar(-amount[0]*span/height).addScaledVector(screenUp, amount[1]*span/height);
    next.eye = v(data.eye).add(shift).toArray(); next.target = target.add(shift).toArray();
  } else if (command === 'zoom') {
    const factor = THREE.MathUtils.clamp(amount, .05, 20);
    next.orthoHeight = Math.max(1e-8, data.orthoHeight*factor);
    next.eye = target.add(offset.multiplyScalar(factor)).toArray();
  } else {
    const angle = Math.PI/12;
    if (command === 'opposite') offset.negate();
    else if (command === 'orbitLeft' || command === 'orbitRight') offset.applyAxisAngle(up, command==='orbitLeft'?angle:-angle);
    else { const q = new THREE.Quaternion().setFromAxisAngle(right, command==='orbitUp'?-angle:angle); offset.applyQuaternion(q); next.up = up.applyQuaternion(q).toArray(); }
    next.eye = target.add(offset).toArray();
  }
  return next;
}
