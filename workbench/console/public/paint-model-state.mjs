import * as THREE from 'three';
import {writeVertexPositions} from './model-edit-steps.mjs';

// Keep an immutable browser baseline: modeling and material preview replay the
// same world-space commands, including vertices split at UV/material seams.
const baselines=new WeakMap();
export function applyModelState(root,state){
  if(!root)return;
  let baseline=baselines.get(root);
  if(!baseline){
    const objects=new Map(),meshes=[],seenGeometry=new Set();
    root.traverse(node=>{
      if(node.userData.modelingObject!==undefined)objects.set(node.userData.modelingObject,node);
      if(node.isMesh){
        // glTF nodes can instance one geometry. A vertex edit is local to its object.
        if(seenGeometry.has(node.geometry))node.geometry=node.geometry.clone();
        seenGeometry.add(node.geometry);
        meshes.push(node);
      }
    });
    baseline={objects,meshes,nodes:[]};
    root.traverse(node=>baseline.nodes.push({node,matrix:node.matrix.clone(),
      position:node.geometry?.attributes.position?.clone(),normal:node.geometry?.attributes.normal?.clone()}));
    baselines.set(root,baseline);
  }
  for(const {node,matrix,position,normal} of baseline.nodes){
    node.matrix.copy(matrix);node.matrix.decompose(node.position,node.quaternion,node.scale);
    if(position)node.geometry.attributes.position.copy(position);
    if(normal&&node.geometry.attributes.normal)node.geometry.attributes.normal.copy(normal);
  }
  root.updateMatrixWorld(true);
  const edited=new Set();
  for(const step of state?.steps||[]){
    if(step.type==='vertexPositions'){
      for(const target of step.targets){
        const node=baseline.meshes[target.mesh];
        if(!node)throw Error('工程建模命令与模型绑定不一致');
        writeVertexPositions(node.geometry.attributes.position,target);
        edited.add(node);
      }
      continue;
    }
    const delta=new THREE.Matrix4().fromArray(step.matrix);
    // Capture every target before changing any parent or split primitive.
    const captures=step.targets.map(target=>{
      const node=target.id!==undefined?baseline.objects.get(target.id):baseline.meshes[target.mesh];
      if(!node)throw Error('工程建模命令与模型绑定不一致');
      return {node,target,world:node.matrixWorld.clone(),inverse:node.matrixWorld.clone().invert(),
        parent:node.parent?.matrixWorld.clone().invert()||new THREE.Matrix4()};
    });
    for(const {node,target,world,inverse,parent} of captures){
      if(target.id!==undefined){
        node.matrix.copy(parent.multiply(delta).multiply(world));
        node.matrix.decompose(node.position,node.quaternion,node.scale);
      }else{
        edited.add(node);
        const local=inverse.multiply(delta).multiply(world),attribute=node.geometry.attributes.position;
        for(const id of target.vertices){const p=new THREE.Vector3().fromBufferAttribute(attribute,id).applyMatrix4(local);attribute.setXYZ(id,p.x,p.y,p.z);}
      }
    }
    root.updateMatrixWorld(true);
  }
  for(const mesh of baseline.meshes){
    mesh.geometry.attributes.position.needsUpdate=true;
    if(edited.has(mesh))mesh.geometry.computeVertexNormals();
    if(mesh.geometry.attributes.normal)mesh.geometry.attributes.normal.needsUpdate=true;
    mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();
  }
}
