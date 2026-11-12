import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageStrokeQueue} from '../public/image-stroke-queue.mjs';

const target={id:'project',documentId:'doc',layerId:'layer',target:'pixels'};
const operation=ink=>({op:'image',action:'stroke',...target,stroke:{color:ink}});
const wait=()=>new Promise(resolve=>setImmediate(resolve));

test('drawing queues only its own revisions and previews buffered strokes without duplication',async()=>{
 let doc={id:target.id,revision:2};
 const promises=[],errors=[];
 const queue=createImageStrokeQueue({read:()=>doc,
   write:(edit,origin)=>new Promise(resolve=>promises.push({edit,origin,resolve})),
   onPreview(){},onStateChange(){},onError:error=>errors.push(error.message)});
 const [first,second,third]=['red','green','blue'].map(operation);
 const origin={...target,revision:2};
 queue.preview(first,origin);
 queue.submit(first,origin);
 queue.submit(second,origin);
 await wait();
 assert.deepEqual(promises[0].origin,{id:'project',revision:2});
 assert.deepEqual(queue.operations(origin),[first,second]);
 doc={...doc,revision:3};
 assert.deepEqual(queue.operations({...target,revision:3}),[second]);
 promises[0].resolve(doc);
 await wait();
 assert.deepEqual(promises[1].origin,{id:'project',revision:3});
 queue.preview(third,{...target,revision:3});
 queue.submit(third,{...target,revision:3});
 const saved=queue.flush();
 // The next external update invalidates our lineage after the second write.
 const accepted={...doc,revision:4};
 doc={...doc,revision:5};
 assert.deepEqual(queue.operations({...target,revision:5}),[]);
 promises[1].resolve(accepted);
 assert.equal(await saved,false);
 assert.equal(promises.length,2);
 assert.match(errors[0],/修订已变化/);
 assert.equal(queue.size,0);
});
