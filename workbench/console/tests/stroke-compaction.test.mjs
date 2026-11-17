import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {encodeStrokeBlock,unpackStrokeBlock,compactPaintStrokes} from '../stroke-compaction.mjs';
import {strokeCount} from '../public/stroke-blocks.mjs';

test('stroke blocks preserve complete operations and reject corrupt or oversized input',()=>{
  const strokes=Array.from({length:401},(_,i)=>i%19===0
    ?{transformUV:{angle:i,offset:[.01,0],copy:true}}
    :{radius:.02,stamps:[[.25,.5,.9]],opacity:.8,surfaceBinding:'original'});
  const before=structuredClone(strokes);
  const paint={layers:[{strokes}],imageDocuments:{}};
  compactPaintStrokes(paint);
  const stored=paint.layers[0].strokes;
  assert.equal(strokeCount(stored),401);
  assert.ok(stored.length<64);
  assert.deepEqual(stored.flatMap(stroke=>stroke.strokeBlock?unpackStrokeBlock(stroke,{spatial:true}):[stroke]),before);
  assert.deepEqual(strokes,before);
  assert.throws(()=>unpackStrokeBlock({...stored[0],strokeBlock:'not gzip'},{spatial:true}),/原始工程未修改/);
  assert.throws(()=>encodeStrokeBlock([{data:'x'.repeat(8*1024*1024)}]),error=>
    error.status===503&&error.message.includes('重试保存'));
});

test('a compaction failure leaves the project and undo history byte-for-byte intact',t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'arachne-compaction-failure-'));
  t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  const program=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import zlib from 'node:zlib';
    import {syncBuiltinESMExports} from 'node:module';
    import {editPaint} from './paint.mjs';
    import {projectDir,read} from './store.mjs';
    import {nativeDemoTemplate} from './scripts/seed-native-demo.mjs';
    import {atomic} from './store.mjs';
    const template=await nativeDemoTemplate();
    atomic(path.join(projectDir(template.id),'project.json'),template);
    let doc=read(template.id);
    const image=(action,extra)=>({op:'image',action,documentId:'image',layerId:'pixel',...extra});
    const brush=image('stroke',{target:'pixels',stroke:{uv:true,rect:[0,0,.1,.1],opacity:.5,color:'#224466',erase:false}});
    doc=editPaint(doc,{revision:doc.revision,operations:[
      image('create',{}),image('addLayer',{kind:'pixel'}),...Array(63).fill(brush)
    ]});
    const project=path.join(projectDir(doc.id),'project.json'),history=path.join(projectDir(doc.id),'history.json');
    const before=[fs.readFileSync(project),fs.readFileSync(history)];
    const gzip=zlib.gzipSync;
    zlib.gzipSync=()=>{throw Error('simulated encoder failure');};syncBuiltinESMExports();
    assert.throws(()=>editPaint(doc,{revision:doc.revision,operations:[brush]}),/笔触压实失败.*重试保存/);
    assert.deepEqual([fs.readFileSync(project),fs.readFileSync(history)],before);
    zlib.gzipSync=gzip;syncBuiltinESMExports();
    doc=editPaint(doc,{revision:doc.revision,operations:[brush]});
    assert.equal(doc.paint.imageDocuments.image.layers[0].strokes[0].count,64);
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',program],{
    cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',
    env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1'}
  });
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
