import * as THREE from 'three';
import {OutlinePass} from 'three/addons/postprocessing/OutlinePass.js';
import {selectionColors} from './viewport-colors.mjs';

// OutlinePass normally adds light to the scene, so its orange disappears on
// white materials/backgrounds. Composite a solid, antialiased color instead.
// Coverage comes from the colored edge texture. Occluded edges use a lighter
// coverage so that the full silhouette remains visible through other objects.
const outlineOverlay = `
  varying vec2 vUv;
  uniform sampler2D maskTexture;
  uniform sampler2D edgeTexture1;
  uniform float edgeStrength;
  uniform vec3 outlineColor;

  void main() {
    vec3 edge = texture2D(edgeTexture1, vUv).rgb;
    float peak = max(max(outlineColor.r, outlineColor.g), outlineColor.b);
    float coverage = max(max(edge.r, edge.g), edge.b) / max(peak, 0.0001);
    coverage = clamp(coverage * edgeStrength * texture2D(maskTexture, vUv).r, 0.0, 1.0);
    gl_FragColor = vec4(outlineColor, coverage);
    #include <colorspace_fragment>
  }
`;

// A display-only silhouette pass. It never changes the project's mesh or material data.
export function createObjectOutline({renderer,scene}){
  let objects=[],active=null,excluded=null,pass=null,projection=null,width=0,height=0;
  const size=new THREE.Vector2();
  function disposePass(){pass?.dispose();pass=null;projection=null;width=height=0;}
  return {
    setObjects(next,helpers=null,activeObject=next.at(-1)??null){objects=[...new Set(next)];active=objects.includes(activeObject)?activeObject:objects.at(-1)??null;excluded=helpers;},
    render(camera){
      if(!objects.length)return;
      const kind=camera.isOrthographicCamera?'orthographic':'perspective';
      if(pass&&projection!==kind)disposePass();
      if(!pass){
        pass=new OutlinePass(new THREE.Vector2(1,1),scene,camera);
        projection=kind;pass.downSampleRatio=Math.max(1,renderer.getPixelRatio());
        pass.edgeStrength=3;pass.edgeThickness=1;pass.edgeGlow=0;pass.pulsePeriod=0;
        pass.overlayMaterial.uniforms.outlineColor={value:pass.visibleEdgeColor};
        pass.overlayMaterial.fragmentShader=outlineOverlay;
        pass.overlayMaterial.blending=THREE.NormalBlending;
        pass.overlayMaterial.needsUpdate=true;
      }
      renderer.getDrawingBufferSize(size);
      const scale=Math.max(1,renderer.getPixelRatio());
      if(size.x!==width||size.y!==height||pass.downSampleRatio!==scale){
        width=size.x;height=size.y;pass.downSampleRatio=scale;pass.setSize(width,height);
      }
      pass.renderCamera=camera;
      const helpersVisible=excluded?.visible,target=renderer.getRenderTarget(),autoClear=renderer.autoClear;
      const background=scene.background,override=scene.overrideMaterial,clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
      try{
        if(excluded)excluded.visible=false;
        // OutlinePass can blend straight into the already drawn default framebuffer.
        // renderToScreen stays false: there is no beauty texture to copy or regrade.
        const other=objects.filter(object=>object!==active);
        for(const [selected,color] of [[other,selectionColors.selected],[[active].filter(Boolean),selectionColors.active]]){
          if(!selected.length)continue;
          pass.selectedObjects=selected;pass.visibleEdgeColor.set(color);
          // Draw through other objects while retaining a cue for depth.
          pass.hiddenEdgeColor.copy(pass.visibleEdgeColor).multiplyScalar(.65);
          pass.render(renderer,null,target,0,false);
        }
      }finally{
        if(excluded)excluded.visible=helpersVisible;
        scene.background=background;scene.overrideMaterial=override;
        renderer.setRenderTarget(target);renderer.setClearColor(clear,alpha);renderer.autoClear=autoClear;
      }
    },
    clear(){objects=[];active=null;excluded=null;disposePass();},
    dispose(){this.clear();}
  };
}
