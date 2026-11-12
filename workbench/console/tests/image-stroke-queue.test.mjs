import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageStrokeQueue} from '../public/image-stroke-queue.mjs';

const target={id:'project',documentId:'doc',layerId:'layer',target:'pixels'};
const operation=ink=>({op:'image',action:'stroke',documentId:target.documentId,layerId:target.layerId,target:'pixels',stroke:{color:ink}});
const wait=()=>new Promise(resolve=>setImmediate(resolve));
const committed=(doc,origin)=>({...doc,revision:origin.revision+1,strokeSaveReceipts:[
  ...(doc.strokeSaveReceipts||[]),{id:origin.strokeRequestId,revision:origin.revision+1}
]});

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
 assert.equal(promises[0].origin.revision,2);
 assert.deepEqual(queue.operations(origin),[first,second]);
 doc=committed(doc,promises[0].origin);
 assert.deepEqual(queue.operations({...target,revision:3}),[second]);
 promises[0].resolve(doc);
 await wait();
 assert.equal(promises[1].origin.revision,3);
 queue.preview(third,{...target,revision:3});
 queue.submit(third,{...target,revision:3});
 const saved=queue.flush();
 // The next external update invalidates our lineage after the second write.
 const accepted=committed(doc,promises[1].origin);
 doc={...accepted,revision:5};
 assert.deepEqual(queue.operations({...target,revision:5}),[]);
 promises[1].resolve(accepted);
 assert.equal(await saved,false);
 assert.equal(promises.length,2);
 assert.match(errors[0],/修订已变化/);
 assert.equal(queue.size,1);
 assert.equal(queue.accepts({...target,revision:5}),false);
});

test('retry confirms a lost acknowledgement before writing the rest of the queue',async()=>{
 let doc={id:target.id,revision:2},server=doc;
 const saved=[],errors=[];
 const queue=createImageStrokeQueue({read:()=>doc,readLatest:async()=>doc=server,
   write:async(edit,origin)=>{
     saved.push(edit.stroke.color);
     server=committed(server,origin);
     if(saved.length===1)throw Error('response lost');
     return doc=server;
   },onPreview(){},onStateChange(){},onError:error=>errors.push(error.message)});
 queue.submit(operation('red'),{...target,revision:2});
 queue.submit(operation('green'),{...target,revision:2});
 assert.equal(await queue.flush(),false);
 assert.equal(queue.size,2);
 assert.deepEqual(errors,['response lost']);
 assert.equal(await queue.retry(),true);
 assert.deepEqual(saved,['red','green']);
 assert.equal(doc.revision,4);
 assert.equal(queue.size,0);
});

test('an uncommitted stroke waits for explicit rebasing when another edit advanced the project',async()=>{
 let doc={id:target.id,revision:2},server=doc,attempts=0;
 const queue=createImageStrokeQueue({read:()=>doc,readLatest:async()=>doc=server,
   write:async(_edit,origin)=>{
     attempts++;
     if(attempts===1)throw Error('offline');
     assert.equal(origin.revision,3);
     return doc=server=committed(server,origin);
   },onPreview(){},onStateChange(){},onError(){}});
 queue.submit(operation('red'),{...target,revision:2});
 assert.equal(await queue.flush(),false);
 server={...server,revision:3};
 assert.equal(await queue.retry(),false);
 assert.equal(queue.canRebase,true);
 assert.equal(attempts,1);
 assert.equal(await queue.retry({rebase:true}),true);
 assert.equal(doc.revision,4);
 assert.equal(queue.size,0);
});
