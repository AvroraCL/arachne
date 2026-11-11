import * as THREE from 'three';
import {selectionColors} from './viewport-colors.mjs';

export function objectOriginCenter(objects) {
  const center=new THREE.Vector3(),point=new THREE.Vector3();
  const nodes=[...new Set(objects)];
  for(const node of nodes)center.add(node.getWorldPosition(point));
  return nodes.length?center.divideScalar(nodes.length):center;
}

// Screen-sized, round origin markers. Geometry bounds never determine origins.
export function createObjectOrigins() {
  const group=new THREE.Group(),point=new THREE.Vector3();
  group.name='Object Origins';
  let objects=[],active=null;
  const markers=[selectionColors.selected,selectionColors.active].map(color=>{
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([],3));
    const material=new THREE.ShaderMaterial({
      uniforms:{color:{value:new THREE.Color(color)},rim:{value:new THREE.Color('#202020')},diameter:{value:9}},
      vertexShader:`uniform float diameter;
        void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_PointSize=diameter;}`,
      fragmentShader:`uniform vec3 color;uniform vec3 rim;
        void main(){float r=length(gl_PointCoord-vec2(0.5));if(r>0.5)discard;
          gl_FragColor=vec4(mix(color,rim,smoothstep(0.30,0.39,r)),1.0-smoothstep(0.44,0.5,r));
          #include <colorspace_fragment>
        }`,
      transparent:true,depthTest:false,depthWrite:false,toneMapped:false
    });
    const marker=new THREE.Points(geometry,material);
    marker.name=color===selectionColors.active?'Active Object Origin':'Selected Object Origins';
    marker.frustumCulled=false;
    // Draw after the transform handles, with the active marker last at shared origins.
    marker.renderOrder=Infinity;
    marker.onBeforeRender=renderer=>{material.uniforms.diameter.value=9*renderer.getPixelRatio();};
    group.add(marker);
    return marker;
  });
  function update(){
    const positions=[[],[]];
    for(const node of objects){
      node.getWorldPosition(point);
      positions[node===active?1:0].push(point.x,point.y,point.z);
    }
    markers.forEach((marker,i)=>{
      const data=positions[i],attribute=marker.geometry.getAttribute('position');
      if(attribute.array.length!==data.length){
        // Release the old GPU buffer when the selection count changes.
        marker.geometry.dispose();marker.geometry=new THREE.BufferGeometry();
        marker.geometry.setAttribute('position',new THREE.Float32BufferAttribute(data,3));
      }
      else {attribute.array.set(data);attribute.needsUpdate=true;}
      marker.visible=!!data.length;
    });
  }
  return {group,update,
    setObjects(next,activeObject){objects=[...new Set(next)];active=activeObject;update();},
    dispose(){group.removeFromParent();for(const marker of markers){marker.geometry.dispose();marker.material.dispose();}objects=[];active=null;}
  };
}
