import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {surfaceMarkMapsChanged,applySourceFactors,createUnlitMaterial,livePaintTextureSpaces,updateLivePaintTextures,fillLivePaintTextures} from '../public/viewport-materials.mjs';

test('a projected mark only needs a new map when its pigment or underlying color changes', () => {
  const cap = {mark:{coverage:'mask-a'},color:'#202020'};
  const before = {cap,trim:{roughness:.4}};
  assert.equal(surfaceMarkMapsChanged(before,{cap:{...cap,roughness:.8},trim:{color:'#ffcc00'}}),false);
  assert.equal(surfaceMarkMapsChanged(before,{cap:{...cap,color:'#808080'}}),true);
  assert.equal(surfaceMarkMapsChanged(before,{cap:{...cap,mark:{coverage:'mask-b'}}}),true);
  assert.equal(surfaceMarkMapsChanged(before,{}),true);
  assert.equal(surfaceMarkMapsChanged(undefined,before),true);
});

test('source PBR edits retain texture bindings and alpha when a cap has no paint UV', () => {
  const map=new THREE.Texture(),normalMap=new THREE.Texture();
  const cap=new THREE.MeshStandardMaterial({map,normalMap,opacity:.4,transparent:true,roughness:.32,metalness:.2});
  const unlit=createUnlitMaterial(cap);
  for(const material of [cap,unlit]){
    applySourceFactors(material,{color:'#474036',metallic:0});
    assert.deepEqual(material.color,new THREE.Color('#474036'));
    assert.equal(material.opacity,.4);
    assert.equal(material.map,map);
  }
  assert.equal(cap.normalMap,normalMap);
  assert.equal(cap.metalness,0);
  assert.equal(cap.roughness,.32);
  assert.equal('roughness' in unlit,false);
});

test('unlit view preserves alpha textures, cutouts and vertex colors without changing the source PBR material', () => {
  const source = new THREE.MeshPhysicalMaterial({
    color: 0x778899, map: new THREE.Texture(), normalMap: new THREE.Texture(),
    alphaMap: new THREE.Texture(), alphaTest: .4, transparent: true, opacity: .17,
    roughness: .3, metalness: .6, side: THREE.FrontSide, depthWrite: false,
    vertexColors: true
  });
  source.userData.sourceMaterial = 'glass';
  let sourceDisposed = false;
  source.addEventListener('dispose', () => { sourceDisposed = true; });
  const alternate = createUnlitMaterial(source);
  for (const key of ['map', 'alphaMap', 'alphaTest', 'transparent', 'opacity', 'side', 'depthWrite', 'vertexColors']) {
    assert.equal(alternate[key], source[key], key);
  }
  assert.deepEqual(alternate.color, source.color);
  assert.notEqual(alternate.color, source.color);
  alternate.dispose();
  assert.equal(sourceDisposed, false);
  assert.equal(source.roughness, .3);
  assert.equal(source.metalness, .6);
  assert.ok(source.normalMap);
});

test('unlit display keeps material identity and independent mutable display state', () => {
  const source = new THREE.MeshStandardMaterial({color: 0x334455});
  source.name = 'retained material';
  source.userData.arachne_material_id = 'material-1';
  const alternate = createUnlitMaterial(source);
  assert.equal(alternate.name, source.name);
  assert.equal(alternate.userData.arachne_material_id, 'material-1');
  alternate.color.set(0xffffff);
  alternate.userData.arachne_material_id = 'alternate';
  assert.equal(source.color.getHex(), 0x334455);
  assert.equal(source.userData.arachne_material_id, 'material-1');
});

test('live viewport allocates only texture slots needed for the enabled channels', () => {
  assert.deepEqual(livePaintTextureSpaces(['color','roughness','metallic','ao']),{
    color:THREE.SRGBColorSpace,scalar:THREE.NoColorSpace
  });
  assert.deepEqual(livePaintTextureSpaces(['color','height','alpha','normal','emission']),{
    color:THREE.SRGBColorSpace,scalar:THREE.NoColorSpace,normal:THREE.NoColorSpace,
    detail:THREE.NoColorSpace,emission:THREE.SRGBColorSpace
  });
});

test('live viewport keeps byte packing and legacy defaults with optional maps', () => {
  const frame=Uint8Array.of(10,20,30,40,50,0,60,70,80,90,100,110,120,130,140);
  const slots=keys=>Object.fromEntries(keys.map(key=>[key,{image:{data:new Uint8Array(4)}}]));
  const output=maps=>Object.fromEntries(Object.entries(maps).map(([key,map])=>[key,[...map.image.data]]));
  const standard=slots(['color','scalar']),full=slots(['color','scalar','normal','detail','emission']);
  fillLivePaintTextures(frame,1,standard);
  assert.deepEqual(output(standard),{color:[10,20,30,255],scalar:[140,50,40,255]});
  fillLivePaintTextures(frame,1,full);
  assert.deepEqual(output(full),{...output(standard),normal:[60,70,80,255],detail:[90,130,0,255],emission:[100,110,120,255]});
  fillLivePaintTextures(frame.slice(0,6),1,full,Uint8Array.of(2,4,6,255));
  assert.deepEqual(output(full),{color:[2,4,6,255],scalar:[255,50,40,255],normal:[128,128,255,255],detail:[128,255,0,255],emission:[0,0,0,255]});
});

test('channel and resolution changes reuse active textures and dispose released slots once', () => {
  let created=0,disposed=0,size=256;
  const create=colorSpace=>({image:{width:size},colorSpace,id:++created,dispose(){disposed++;}});
  let result=updateLivePaintTextures(null,size,[],create);
  assert.equal(created,2);
  const base=result.maps.color;
  result=updateLivePaintTextures(result.maps,size,['alpha','height','normal'],create);
  assert.equal(result.maps.color,base);assert.equal(created,4);
  const shared=result.maps.detail;
  result=updateLivePaintTextures(result.maps,size,['height'],create);
  assert.equal(result.maps.detail,shared);assert.equal(disposed,1);
  result=updateLivePaintTextures(result.maps,size,['height'],create);
  assert.equal(result.changed,false);assert.equal(created,4);assert.equal(disposed,1);
  size=4096;
  result=updateLivePaintTextures(result.maps,size,[],create);
  assert.deepEqual(Object.keys(result.maps),['color','scalar']);assert.equal(created,6);assert.equal(disposed,4);
});

test('paint atlas protects matching UV edges only when the model-space surfaces differ', async () => {
  const {touchingPaintBounds} = await import('../public/viewport-uv-contact.mjs');
  const material = new THREE.MeshStandardMaterial();
  material.name = 'panel';
  const root = new THREE.Group();
  function face(points) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(points.flat(),2));
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(points.flatMap(([u,v])=>[u,v,0]),3));
    geometry.setIndex([0,1,2]);
    const mesh = new THREE.Mesh(geometry,material);
    root.add(mesh);
    return mesh;
  }
  const left = face([[0,0],[.5,0],[.5,1]]);
  const right = face([[.5,1],[.5,0],[1,1]]);
  assert.equal(touchingPaintBounds(root,'panel').size,0);
  right.position.x = .5;
  const guards = touchingPaintBounds(root,'panel');
  assert.equal(guards.get(left).z,.5);
  assert.equal(guards.get(right).x,.5);
  assert.equal(touchingPaintBounds(root,'rivet').size,0);
});
