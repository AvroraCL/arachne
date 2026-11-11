import * as THREE from 'three';

export const worldAxes=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);
export function modelOrientation(object,orientation='global'){
  if(orientation!=='local'||!object)return worldAxes.clone();
  // glTF node rotations use Y-up; the user's transform axes use Blender Z-up.
  const rotation=new THREE.Quaternion();object.updateWorldMatrix(true,false);
  object.matrixWorld.decompose(new THREE.Vector3(),rotation,new THREE.Vector3());
  return rotation.normalize().multiply(worldAxes);
}

export function numericModelDelta(tool,values,pivot,orientation=worldAxes){
  const limit={translate:1000,rotate:36000,scale:100}[tool];
  if(!Number.isFinite(limit)||!Array.isArray(values)||values.length!==3||
    values.some(value=>!Number.isFinite(value)||Math.abs(value)>limit)||
    tool==='scale'&&values.some(value=>Math.abs(value)<.01)){
    throw Error('变换数值超出范围，缩放倍数的绝对值至少为 0.01');
  }
  const vector=new THREE.Vector3(...values),rotation=new THREE.Quaternion();
  if(tool==='rotate')rotation.setFromEuler(new THREE.Euler(...values.map(THREE.MathUtils.degToRad),'XYZ'));
  const basis=new THREE.Matrix4().makeRotationFromQuaternion(orientation);
  return new THREE.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z).multiply(basis)
    .multiply(new THREE.Matrix4().compose(tool==='translate'?vector:new THREE.Vector3(),rotation,tool==='scale'?vector:new THREE.Vector3(1,1,1)))
    .multiply(basis.clone().invert()).multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
}

const toolNames={translate:'移动',rotate:'旋转',scale:'缩放'},axisNames='XYZ';
const clean=n=>Number(n.toFixed(4)).toString();

export function constraintSegment(camera,center,direction){
  camera.updateMatrixWorld(true);
  const clip=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(clip);let first=-Infinity,last=Infinity;
  for(const plane of frustum.planes){
    const distance=plane.distanceToPoint(center),rate=plane.normal.dot(direction);
    if(Math.abs(rate)<1e-12){if(distance<0)return null;continue;}
    const t=-distance/rate;if(rate>0)first=Math.max(first,t);else last=Math.min(last,t);
  }
  if(!Number.isFinite(first)||!Number.isFinite(last)||first>last)return null;
  // Keep the GL line endpoints inside the near/far clip planes.
  const inset=Math.min((last-first)*1e-5,1e-4);
  return [center.clone().addScaledVector(direction,first+inset),center.clone().addScaledVector(direction,last-inset)];
}

// A frozen transform frame. All previews are absolute deltas from gesture start.
export function createModelTransform({tool,pivot,orientation='global',localFrame,camera,rect,pointer}){
  const center=pivot.clone(),view=camera.clone();view.updateMatrixWorld(true);
  const global=worldAxes.clone(),local=localFrame.clone(),screenCenter=project(center);
  const start=new THREE.Vector2(pointer?.clientX??screenCenter.x+80,pointer?.clientY??screenCenter.y);
  let current=start.clone(),axis=null,exclude=false,stage=0,typed=[null,null,null],component=0,multiple=false,shift=false,ctrl=false;
  const normal=view.getWorldDirection(new THREE.Vector3()),plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,center),ray=new THREE.Raycaster();
  const initial=unproject(start),screenStart=start.clone().sub(screenCenter);
  let previousAngle=Math.atan2(screenStart.y,screenStart.x),rotation=0;
  let valueLabel='',validation='';
  function project(point){const p=point.clone().project(view);return new THREE.Vector2(rect.left+(p.x+1)*rect.width/2,rect.top+(1-p.y)*rect.height/2);}
  function unproject(point){ray.setFromCamera(new THREE.Vector2((point.x-rect.left)/rect.width*2-1,1-(point.y-rect.top)/rect.height*2),view);return ray.ray.intersectPlane(plane,new THREE.Vector3())||center.clone();}
  function frameName(){return stage===2?(orientation==='global'?'local':'global'):orientation;}
  function frame(){return frameName()==='local'?local:global;}
  function worldAxis(index=axis){return new THREE.Vector3().setComponent(index,1).applyQuaternion(frame());}
  function constrained(values,neutral=0){return values.map((n,i)=>axis===null||exclude&&i!==axis||!exclude&&i===axis?n:neutral);}
  function components(){return [0,1,2].filter(i=>axis===null||exclude&&i!==axis||!exclude&&i===axis);}
  function snap(value){if(!ctrl)return value;const increment=tool==='rotate'?(shift?1:5):tool==='scale'?(shift?.01:.1):(shift?.01:.1);return Math.round(value/increment)*increment;}
  function aboutAxis(degrees,direction){return new THREE.Matrix4().makeTranslation(center.x,center.y,center.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(direction,THREE.MathUtils.degToRad(degrees)))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x,-center.y,-center.z));}
  function result(){
    validation='';
    try{
      const indices=components(),entries=typed.slice(0,indices.length),hasNumber=entries.some(n=>n!==null),number=typed[component]===null||typed[component]===''?(tool==='scale'?1:0):Number(typed[component]);
      if(hasNumber&&entries.some(n=>n!==null&&!Number.isFinite(Number(n))))throw Error('继续输入数值，或 Esc 取消');
      let values;
      if(hasNumber){
        if(tool==='rotate'){
          if(Math.abs(number)>36000)throw Error('旋转角度超出范围');
          valueLabel=clean(number)+'°';
          return aboutAxis(number,axis===null?normal:worldAxis());
        }
        if(multiple){values=[0,0,0].map(()=>tool==='scale'?1:0);indices.forEach((index,i)=>{values[index]=typed[i]===null||typed[i]===''?(tool==='scale'?1:0):Number(typed[i]);});}
        else if(tool==='scale')values=constrained([number,number,number],1);
        else {values=[0,0,0];values[indices[0]]=number;}
      }else if(tool==='translate'){
        const displacement=unproject(current).sub(initial).multiplyScalar(shift?.1:1).applyQuaternion(frame().clone().invert());
        values=constrained(displacement.toArray().map(snap));
        if(axis!==null&&!exclude){
          const screenAxis=project(center.clone().add(worldAxis())).sub(screenCenter),delta=current.clone().sub(start);
          const amount=screenAxis.lengthSq()>1e-4?delta.dot(screenAxis)/screenAxis.lengthSq():-delta.y*unproject(start.clone().add(new THREE.Vector2(0,1))).distanceTo(initial);
          values=[0,0,0];values[axis]=snap(amount*(shift?.1:1));
        }
      }else if(tool==='scale'){
        let direction=screenStart.clone().normalize();
        if(axis!==null&&!exclude)direction=project(center.clone().add(worldAxis())).sub(screenCenter).normalize();
        if(direction.lengthSq()<.1)direction.set(1,0);
        let lever=screenStart.dot(direction);if(Math.abs(lever)<40)lever=80;
        const factor=snap(1+current.clone().sub(start).dot(direction)/lever*(shift?.1:1));
        values=constrained([factor,factor,factor],1);
      }else{
        let angle=screenStart.length()<12?(current.x-start.x)*.5:rotation;
        if(axis!==null&&worldAxis().dot(normal)<0)angle=-angle;
        angle=snap(angle*(shift?.1:1));valueLabel=clean(angle)+'°';
        return aboutAxis(angle,axis===null?normal:worldAxis());
      }
      valueLabel=values.map(clean).join(', ');
      return numericModelDelta(tool,values,center,frame());
    }catch(error){validation=error.message;return null;}
  }
  function key(event){
    const k=event.key.toLowerCase();
    if(['x','y','z'].includes(k)){
      const next=axisNames.indexOf(k.toUpperCase()),planeLock=event.shiftKey&&tool!=='rotate';
      if(axis===next&&exclude===planeLock){stage=(stage+1)%3;if(!stage)axis=null;}
      else{axis=next;exclude=planeLock;stage=1;}
      component=Math.min(component,components().length-1);
      return true;
    }
    if(k==='tab'&&tool!=='rotate'&&components().length>1){const count=components().length;component=(component+(event.shiftKey?count-1:1))%count;multiple=true;typed[component]??='';return true;}
    if(k==='backspace'){if(typed[component]===null)return true;typed[component]=typed[component].slice(0,-1);if(!typed[component])typed[component]=null;return true;}
    if(k==='delete'){typed=[null,null,null];multiple=false;component=0;return true;}
    if(k==='-'||k==='+'){const n=typed[component]??'';typed[component]=k==='+'?n.replace(/^-/,''):n.startsWith('-')?n.slice(1):'-'+n;return true;}
    if(/^\d$/.test(k)||k==='.'||k===','){
      const next=k===','?'.':k,value=typed[component]??'';
      if(next==='.'&&value.includes('.'))return true;
      if(value.length<16)typed[component]=value+next;
      return true;
    }
    return false;
  }
  return {tool,key,result,
    move(event){current.set(event.clientX,event.clientY);shift=event.shiftKey;ctrl=event.ctrlKey||event.metaKey;
      const offset=current.clone().sub(screenCenter),angle=Math.atan2(offset.y,offset.x);
      if(offset.length()>2){rotation+=THREE.MathUtils.euclideanModulo((angle-previousAngle)*180/Math.PI+180,360)-180;previousAngle=angle;}
    },
    modifiers(event){shift=event.shiftKey;ctrl=event.ctrlKey||event.metaKey;},
    describe(){const entries=typed.slice(0,components().length),numeric=entries.some(n=>n!==null),entry=multiple?entries.map((n,i)=>(i===component?'[':'')+(n??'·')+(i===component?']':'')).join(', '):typed[component];return {tool,axis:axis===null?null:axisNames[axis],exclude,orientation:frameName(),error:validation,
      label:toolNames[tool]+' · '+(frameName()==='local'?'局部':'全局')+(axis===null?'':(exclude?' 平面 ':' ')+axisNames[axis])+' · '+(numeric?(entry??''):valueLabel)+' · Enter 确认 / Esc 取消'};},
    guide(){return axis===null?[]:(exclude?[0,1,2].filter(i=>i!==axis):[axis]).map(i=>({axis:axisNames[i],direction:worldAxis(i)}));}
  };
}
