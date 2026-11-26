import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveView,sampleMaterialFrame} from '../public/paint-live-view.mjs';

test('material picker interpolates color in linear light and samples scalar and normal channels directly',()=>{
  const dark=[0,0,0,0,51,0,32,64,192,51,0,0,0,204,64];
  const light=[255,255,255,255,204,0,224,192,64,204,255,255,255,51,192];
  const frame={request:{size:2},pixels:Uint8Array.from([...dark,...light,...dark,...light])};
  const values=sampleMaterialFrame(frame,.5,.5);
  assert.deepEqual(values,{color:'#bcbcbc',metallic:.5,roughness:.5,normal:'#808080',height:.5,emission:'#bcbcbc',alpha:.5,ao:128/255});
  assert.equal(sampleMaterialFrame(frame,.25,.75).color,'#000000');
  assert.equal(sampleMaterialFrame(frame,1,.5).color,'#ffffff');
  assert.equal(sampleMaterialFrame({...frame,request:{size:2,inspectMask:'mask'}},.5,.5),null);
  assert.equal(sampleMaterialFrame({...frame,request:{size:2,operation:{op:'stroke'}}},.5,.5),null);
  assert.equal(sampleMaterialFrame(frame,NaN,.5),null);
});

function fixture(t,detail=false,{page,...options}={}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (_url, {body,signal}) => new Promise((resolve,reject) => {
    requests.push({data: JSON.parse(body), resolve,reject,signal});
  }));
  let state = {id:'fixture',revision:1,key:'fixture:1',channel:'color',preview3D:true,detail};
  const drawn = [],statuses=[];let drawFailure=false;
  const canvas = draw => ({ownerDocument:page,getContext:()=>({
    createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
    putImageData:({data})=>{if(drawFailure)throw new TypeError('画布不可用');draw(data[0]);},
    clearRect(){}
  })});
  const view = createLiveView({
    viewport:{showLivePaint(){},setUnlit(){}},
    canvas:canvas(color=>drawn.push(color)),guide:canvas(()=>{}),
    context:()=>state,onStatus:(text,error,detail)=>statuses.push({text,error,...detail}),...options
  });
  return {
    view, requests, drawn, statuses,
    revise(revision){state={...state,revision,key:'fixture:'+revision};},
    configure(update){state={...state,...update};view.preferencesChanged();},setDrawFailure(value){drawFailure=value;},
    async fail(index,status=500){
      requests[index].resolve(Response.json({error:'暂时不可用'},{status}));
      await new Promise(resolve=>setImmediate(resolve));
    },
    async networkFail(index){requests[index].reject(new TypeError('网络暂时不可用'));await new Promise(resolve=>setImmediate(resolve));},
    async busyWithoutJson(index){requests[index].resolve(new Response('temporary failure',{status:503}));await new Promise(resolve=>setImmediate(resolve));},
    async finish(index,color,size=256){
      requests[index].resolve(new Response(new Uint8Array(size*size*(options.rgba?4:6)).fill(color)));
      await new Promise(resolve=>setImmediate(resolve));
    }
  };
}
async function waitRequests(requests,count,timeout=1500){const end=Date.now()+timeout;while(Date.now()<end&&requests.length<count)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(requests.length,count);}

test('polling preserves the latest draft and cancel restores the committed frame immediately', async t => {
  const {view,requests,drawn,finish}=fixture(t);
  view.refresh();
  view.refresh();
  assert.equal(requests.length,1);
  await finish(0,1);

  view.update({op:'stroke',id:'layer',step:1});
  view.update({op:'stroke',id:'layer',step:2});
  view.refresh();
  await finish(1,5);
  assert.equal(requests[2].data.operation.step,2);
  assert.equal(drawn.at(-1),5);

  view.update(null);
  assert.equal(drawn.at(-1),1);
  await finish(2,9);
  assert.equal(drawn.at(-1),1);
  assert.equal(requests.length,3);
});

test('camera edits retain the committed texture across revisions and never promote a draft',async t=>{
  const {view,requests,revise,configure,finish}=fixture(t,false,{renderCanvas:false});
  view.refresh();await finish(0,23);
  const pixels=view.getFrame().pixels;
  view.update({op:'shader',graph:{}});await finish(1,95);
  assert.equal(view.getFrame().pixels[0],95);
  for(const revision of [2,3]){
    revise(revision);configure({reuseKey:'fixture:'+(revision-1)});view.refresh();
    assert.equal(view.getFrame().pixels,pixels);
    assert.equal(view.getFrame().request.revision,revision);
    assert.equal(requests.length,2);
  }
  revise(4);configure({reuseKey:undefined});view.refresh();await finish(2,43);
  assert.equal(view.getFrame().pixels[0],43);
  revise(5);configure({key:'fixture:5:mask',reuseKey:'fixture:4:mask',inspectMask:'mask'});view.refresh();
  assert.equal(requests[3].data.inspectMask,'mask');await finish(3,50);
  assert.equal(view.getFrame().pixels[0],50);
});

test('restoring a cached committed frame republishes it to independent viewports',async t=>{
  const frames=[],{view,requests,finish}=fixture(t,false,{renderCanvas:false,onFrame:frame=>frames.push(frame)});
  view.refresh();await finish(0,1);view.update({op:'shader',graph:{}});await finish(1,9);assert.ok(frames.at(-1).request.operation);
  view.update(null);assert.equal(frames.at(-1).request.operation,null);assert.equal(frames.at(-1).pixels[0],1);assert.equal(requests.length,2);view.clear();
});

test('a suspended preview cancels pending work, retains its last frame and resumes the current revision',async t=>{
  const {view,requests,drawn,finish,revise}=fixture(t);
  view.refresh();await finish(0,7);
  const previous=view.getFrame();
  revise(2);view.refresh();view.setVisible(false);
  assert.equal(requests[1].signal.aborted,true);
  revise(3);view.refresh();view.update(null);view.retryDetail();
  await finish(1,9);
  assert.equal(requests.length,2);assert.equal(view.getFrame(),previous);assert.deepEqual(drawn,[7]);
  view.setVisible(true);view.refresh();
  assert.equal(requests[2].data.revision,3);
  await finish(2,12);assert.deepEqual(drawn,[7,12]);view.clear();
});

test('hidden tabs abort 4K preview, keep the last pixels and resume only visible editors',async t=>{
  const page=Object.assign(new EventTarget(),{hidden:false});
  const setHidden=hidden=>{page.hidden=hidden;page.dispatchEvent(new Event('visibilitychange'));};
  const {view,requests,drawn,finish,revise}=fixture(t,false,{page});
  view.refresh();
  await finish(0,7);
  const previous=view.getFrame();
  view.retryDetail();
  assert.equal(requests[1].data.resolution,4096);
  setHidden(true);
  assert.equal(requests[1].signal.aborted,true);
  revise(2);
  view.refresh();
  await finish(1,9);
  assert.equal(requests.length,2);
  assert.equal(view.getFrame(),previous);
  view.setVisible(false);
  setHidden(false);
  assert.equal(requests.length,2);
  view.setVisible(true);
  view.refresh();
  assert.equal(requests[2].data.revision,2);
  await finish(2,12);
  setHidden(true);
  revise(3);
  setHidden(false);
  assert.equal(requests[3].data.revision,3);
  await finish(3,14);
  assert.deepEqual(drawn,[7,12,14]);
  view.dispose();
  revise(4);
  setHidden(true);
  setHidden(false);
  assert.equal(requests.length,4);
});

test('restoring the same revision does not republish its cached frame or read an aborted detail response',async t=>{
  const frames=[],{view,requests,finish}=fixture(t,false,{onFrame:frame=>frames.push(frame)});
  view.refresh();await finish(0,7);
  const previous=view.getFrame();
  view.retryDetail();assert.equal(requests[1].data.resolution,4096);
  view.setVisible(false);view.setVisible(true);view.refresh();
  let read=false;
  requests[1].resolve({ok:true,headers:new Headers(),arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(read,false);assert.equal(requests.length,2);assert.equal(view.getFrame(),previous);
  assert.deepEqual(frames,[previous]);view.clear();
});

test('a failed cached-frame publication keeps the previous frame and can be retried',async t=>{
  let fail=false;const frames=[],{view,requests,statuses,finish}=fixture(t,false,{renderCanvas:false,onFrame:frame=>{if(fail)throw Error('视口不可用');frames.push(frame);}});
  view.refresh();await finish(0,1);view.update({op:'shader',graph:{}});await finish(1,9);fail=true;view.update(null);assert.ok(view.getFrame().request.operation);assert.equal(statuses.at(-1).phase,'error');
  fail=false;view.retryDetail();assert.equal(view.getFrame().request.operation,null);assert.equal(frames.at(-1).pixels[0],1);assert.equal(requests.length,2);view.clear();
});

test('a context change during cached-frame publication cannot replace a newer view',async t=>{
  let state,change=false;state=fixture(t,false,{onFrame:frame=>{if(change&&!frame.request.operation){change=false;state.revise(2);}}});
  const {view,requests,drawn,finish}=state;view.refresh();await finish(0,1);view.update({op:'shader',graph:{}});await finish(1,9);change=true;view.update(null);assert.equal(drawn.at(-1),9);view.refresh();assert.equal(requests[2].data.revision,2);await finish(2,5);assert.equal(drawn.at(-1),5);view.clear();
});

test('a revision or source switch rejects stale responses even when the same key returns', async t => {
  const {view,requests,drawn,revise,finish}=fixture(t);
  view.refresh();
  revise(2);
  view.refresh();
  await finish(0,1);
  assert.deepEqual(drawn,[]);
  assert.equal(requests[1].data.revision,2);

  view.clear();
  view.refresh();
  await finish(1,5);
  assert.deepEqual(drawn,[]);
  await finish(2,9);
  assert.deepEqual(drawn,[9]);
});

test('a failed draft retains the last frame and a manual retry keeps its intent', async t => {
  const {view,requests,drawn,finish,fail}=fixture(t);
  view.refresh();
  await finish(0,1);
  view.update({op:'transformUV',id:'layer'});
  await fail(1);
  assert.equal(drawn.at(-1),1);
  view.retryDetail();
  assert.equal(requests[2].data.operation.op,'transformUV');
  await finish(2,7);
  assert.equal(drawn.at(-1),7);
});

test('busy fast preview automatically retries the latest revision without discarding its previous frame',async t=>{
  const {view,requests,drawn,statuses,revise,finish,fail}=fixture(t,false,{retryDelays:[8,16]});
  view.refresh();await finish(0,1);revise(2);view.refresh();await fail(1,503);
  assert.equal(drawn.at(-1),1);assert.equal(statuses.at(-1).phase,'retrying');assert.equal(statuses.at(-1).revision,1);assert.equal(statuses.at(-1).size,256);
  for(let i=0;i<4;i++)view.refresh();await waitRequests(requests,3);assert.equal(requests[2].data.revision,2);await finish(2,7);assert.equal(drawn.at(-1),7);assert.equal(statuses.at(-1).revision,2);view.clear();
});

test('a temporary connection failure automatically retries without replacing the last frame',async t=>{
  const {view,requests,drawn,statuses,revise,finish,networkFail}=fixture(t,false,{retryDelays:[8]});
  view.refresh();await finish(0,1);revise(2);view.refresh();await networkFail(1);assert.equal(statuses.at(-1).phase,'retrying');assert.equal(drawn.at(-1),1);
  await waitRequests(requests,3);await finish(2,5);assert.equal(drawn.at(-1),5);assert.equal(statuses.at(-1).revision,2);view.clear();
});

test('busy responses without JSON retry, but errors in preview rendering do not',async t=>{
  const {view,requests,statuses,finish,busyWithoutJson}=fixture(t,false,{retryDelays:[8],onFrame:()=>{throw new TypeError('渲染器错误');}});
  view.refresh();await busyWithoutJson(0);assert.equal(statuses.at(-1).phase,'retrying');await waitRequests(requests,2);await finish(1,3);
  assert.equal(statuses.at(-1).phase,'error');assert.equal(statuses.at(-1).size,0);assert.match(statuses.at(-1).message,/渲染器错误/);await new Promise(resolve=>setTimeout(resolve,35));assert.equal(requests.length,2);view.clear();
});

test('a failed canvas update keeps the previous frame metadata until an explicit successful retry',async t=>{
  const {view,requests,statuses,drawn,revise,finish,setDrawFailure}=fixture(t,false,{retryDelays:[5]});
  view.refresh();await finish(0,1);revise(2);view.refresh();setDrawFailure(true);await finish(1,7);
  assert.equal(drawn.at(-1),1);assert.equal(statuses.at(-1).phase,'error');assert.equal(statuses.at(-1).revision,1);assert.equal(statuses.at(-1).size,256);
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(requests.length,2);setDrawFailure(false);view.retryDetail();await finish(2,7);assert.equal(statuses.at(-1).revision,2);assert.equal(drawn.at(-1),7);view.clear();
});

test('a context change during frame publication does not draw the superseded revision',async t=>{
  let fixtureState,change=true;fixtureState=fixture(t,false,{onFrame:()=>{if(change){change=false;fixtureState.revise(2);}}});
  const {view,requests,drawn,finish}=fixtureState;view.refresh();await finish(0,1);assert.deepEqual(drawn,[]);view.refresh();assert.equal(requests[1].data.revision,2);await finish(1,6);assert.deepEqual(drawn,[6]);view.clear();
});

test('changing revision, cancelling a draft, or clearing cancels scheduled busy retries',async t=>{
  const {view,requests,drawn,revise,finish,fail}=fixture(t,false,{retryDelays:[120,180]});
  view.refresh();await finish(0,1);revise(2);view.refresh();await fail(1,503);revise(3);view.refresh();assert.equal(requests[2].data.revision,3);await finish(2,3);
  await new Promise(resolve=>setTimeout(resolve,210));assert.equal(requests.length,3);assert.equal(drawn.at(-1),3);
  view.update({op:'stroke',id:'layer'});await fail(3,503);view.update(null);await new Promise(resolve=>setTimeout(resolve,210));assert.equal(requests.length,4);assert.equal(drawn.at(-1),3);
  revise(4);view.refresh();await fail(4,503);view.clear();await new Promise(resolve=>setTimeout(resolve,210));assert.equal(requests.length,5);
});

test('busy detail automatically retries while keeping the real 256 frame and respects disabling 4K',async t=>{
  const {view,requests,drawn,statuses,configure,finish,fail}=fixture(t,true,{retryDelays:[100,160]});configure({detailDelay:10});
  view.refresh();await finish(0,1);await waitRequests(requests,2);await fail(1,503);assert.equal(statuses.at(-1).phase,'retrying');assert.equal(statuses.at(-1).size,256);
  configure({detail:false});await new Promise(resolve=>setTimeout(resolve,180));assert.equal(requests.length,2);assert.equal(drawn.at(-1),1);
  configure({detail:true,detailDelay:10});await waitRequests(requests,3);await fail(2,503);await waitRequests(requests,4);assert.equal(requests[3].data.resolution,4096);await finish(3,8,4096);assert.equal(statuses.at(-1).phase,'ready');assert.equal(statuses.at(-1).size,4096);view.clear();
});

test('an explicitly requested 4K retry survives busy responses even when automatic 4K is off',async t=>{
  const {view,requests,statuses,finish,fail}=fixture(t,false,{retryDelays:[8,16]});
  view.refresh();await finish(0,1);view.retryDetail();assert.equal(requests[1].data.resolution,4096);await fail(1,503);await waitRequests(requests,3);assert.equal(requests[2].data.resolution,4096);await finish(2,8,4096);assert.equal(statuses.at(-1).phase,'ready');view.clear();
});

test('manual retry during backoff starts immediately and cancels the old timer',async t=>{
  const {view,requests,finish,fail}=fixture(t,false,{retryDelays:[120,160]});
  view.refresh();await fail(0,503);view.retryDetail();assert.equal(requests.length,2);assert.equal(requests[1].data.resolution,256);await finish(1,4);await new Promise(resolve=>setTimeout(resolve,210));assert.equal(requests.length,2);view.clear();
});

test('persistent busy errors stop after bounded retries and expose a manual fast-preview retry',async t=>{
  const {view,requests,statuses,finish,fail}=fixture(t,false,{retryDelays:[5,8]});
  view.refresh();await fail(0,503);await waitRequests(requests,2);await fail(1,503);await waitRequests(requests,3);await fail(2,503);
  assert.equal(statuses.at(-1).error,true);assert.equal(statuses.at(-1).phase,'error');assert.equal(statuses.at(-1).failedSize,256);
  for(let i=0;i<8;i++){view.refresh();await new Promise(resolve=>setTimeout(resolve,8));}assert.equal(requests.length,3);
  view.retryDetail();assert.equal(requests[3].data.resolution,256);await finish(3,5);assert.equal(statuses.at(-1).phase,'fast');view.clear();
});

test('persistent 4K busy errors retain the fast frame and allow an explicit detail retry',async t=>{
  const {view,requests,statuses,drawn,configure,finish,fail}=fixture(t,true,{retryDelays:[5]});configure({detailDelay:10});
  view.refresh();await finish(0,1);await waitRequests(requests,2);await fail(1,503);await waitRequests(requests,3);await fail(2,503);
  assert.equal(statuses.at(-1).phase,'error');assert.equal(statuses.at(-1).failedSize,4096);assert.equal(statuses.at(-1).size,256);assert.equal(drawn.at(-1),1);
  for(let i=0;i<5;i++){view.refresh();await new Promise(resolve=>setTimeout(resolve,8));}assert.equal(requests.length,3);
  view.retryDetail();assert.equal(requests[3].data.resolution,4096);await finish(3,9,4096);assert.equal(statuses.at(-1).phase,'ready');view.clear();
});

test('cancelling a failed draft restores the cached frame and clears its obsolete error',async t=>{
  const {view,requests,statuses,drawn,finish,fail}=fixture(t);
  view.refresh();await finish(0,1);view.update({op:'stroke',id:'layer'});await fail(1);
  assert.equal(statuses.at(-1).error,true);view.update(null);
  assert.equal(drawn.at(-1),1);assert.equal(statuses.at(-1).error,false);assert.equal(statuses.at(-1).phase,'fast');assert.equal(requests.length,2);view.clear();
});

test('failed 4K remains failed through polling and waits for an explicit retry',async t=>{
  const {view,requests,statuses,configure,finish,fail}=fixture(t,true);configure({detailDelay:25});
  view.refresh();await finish(0,1);
  for(let i=0;i<30&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
  await fail(1);
  for(let i=0;i<6;i++){view.refresh();await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(requests.length,2);assert.equal(statuses.at(-1).phase,'error');assert.equal(statuses.at(-1).size,256);
  view.retryDetail();assert.equal(requests.length,3);assert.equal(statuses.at(-1).phase,'refining');await finish(2,9,4096);assert.equal(statuses.at(-1).phase,'ready');view.clear();
});

test('idle detail remains available when a lower resolution gesture is cancelled', async t => {
  const {view,requests,drawn,finish}=fixture(t,true);
  view.refresh();
  assert.equal(requests[0].data.resolution,256);
  await finish(0,1);
  for(let i=0;i<60&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(requests[1].data.resolution,4096);
  await finish(1,9,4096);
  view.update({op:'stroke',id:'layer'});
  assert.equal(requests[2].data.resolution,256);
  await finish(2,4);
  view.update(null);
  assert.equal(drawn.at(-1),9);
  assert.equal(requests.length,3);
  view.clear();
});


test('4K failure preserves actual fast resolution and an explicit retry can succeed',async t=>{
  const {view,requests,drawn,statuses,finish,fail}=fixture(t,true);
  view.refresh();await finish(0,1);
  assert.equal(statuses.at(-1).size,256);
  for(let i=0;i<60&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(statuses.at(-1).phase,'refining');assert.equal(statuses.at(-1).size,256);
  await fail(1);assert.equal(drawn.at(-1),1);
  assert.equal(statuses.at(-1).phase,'error');assert.equal(statuses.at(-1).size,256);
  view.refresh();assert.equal(requests.length,2);
  view.retryDetail();assert.equal(requests[2].data.resolution,4096);
  await finish(2,8,4096);
  assert.equal(statuses.at(-1).size,4096);assert.equal(statuses.at(-1).phase,'ready');
  assert.equal(statuses.at(-1).revision,1);view.refresh();assert.equal(statuses.at(-1).phase,'ready');view.clear();
});

test('new strokes abort pending 4K; a late old revision never replaces their fast frame',async t=>{
  const {view,requests,drawn,statuses,finish,revise}=fixture(t,true);
  view.refresh();await finish(0,1);
  for(let i=0;i<60&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,25));
  view.update({op:'stroke',id:'layer'});assert.equal(requests[1].signal.aborted,true);
  assert.equal(requests[2].data.operation.op,'stroke');
  revise(2);view.refresh();await finish(1,9,4096);
  assert.equal(drawn.at(-1),1);
  await finish(2,6);
  assert.equal(drawn.at(-1),1);assert.equal(requests[3].data.revision,2);
  await finish(3,3);assert.equal(drawn.at(-1),3);
  assert.equal(statuses.at(-1).revision,2);assert.equal(statuses.at(-1).size,256);
  view.clear();
});


test('turning auto 4K off cancels pending detail, quick re-enable respects the new idle delay',async t=>{
  const {view,requests,drawn,finish,configure}=fixture(t,true);
  view.refresh();await finish(0,1);
  for(let i=0;i<60&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,25));
  configure({detail:false});assert.equal(requests[1].signal.aborted,true);
  configure({detail:true,detailDelay:300});
  await finish(1,9,4096);assert.equal(drawn.at(-1),1);
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(requests.length,2);
  for(let i=0;i<30&&requests.length<3;i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(requests[2].data.resolution,4096);
  await finish(2,7,4096);assert.equal(drawn.at(-1),7);
  configure({detail:false});view.refresh();assert.equal(drawn.at(-1),7);
  assert.equal(requests.length,3);view.clear();
});


test('the saved revision counts down beside fast preview and a late fast response cannot downgrade 4K',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {view,requests,drawn,configure,finish}=fixture(t,true,{rgba:true});
  configure({detailDelay:300});
  view.refresh();
  assert.equal(requests[0].data.resolution,256);
  t.mock.timers.tick(299);
  assert.equal(requests.length,1);
  t.mock.timers.tick(1);
  assert.equal(requests[1].data.resolution,4096);
  assert.equal(requests[0].signal.aborted,false);
  await finish(1,9,4096);
  assert.equal(requests[0].signal.aborted,true);
  await finish(0,3);
  assert.deepEqual(drawn,[9]);
  view.clear();
});

test('fast preview can publish while 4K loads and a new stroke rejects its stale body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {view,requests,drawn,statuses,configure,finish,revise}=fixture(t,true,{rgba:true});
  configure({detailDelay:300});
  view.refresh();
  t.mock.timers.tick(300);
  await finish(0,7);
  assert.equal(statuses.at(-1).phase,'refining');
  const body=Promise.withResolvers();
  requests[1].resolve({ok:true,headers:new Headers(),arrayBuffer:()=>body.promise});
  await new Promise(resolve=>setImmediate(resolve));
  view.update({op:'image',action:'stroke'});
  assert.equal(requests[1].signal.aborted,true);
  assert.equal(requests[2].data.resolution,256);
  await finish(2,8);
  t.mock.timers.tick(1200);
  assert.equal(requests.length,3);
  body.resolve(new Uint8Array(4096*4096*4).fill(9).buffer);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(drawn,[7,8]);

  revise(2);view.refresh();
  t.mock.timers.tick(300);
  assert.equal(requests[4].data.revision,2);
  await finish(3,3);await finish(4,5,4096);
  assert.deepEqual(drawn,[7,8,3,5]);
  view.clear();
});

test('an exact stroke patch survives its matching save and yields to the next committed fast frame',async t=>{
  // Node has no DOM ImageData constructor. The fixture only reads its data.
  const previous=globalThis.ImageData;
  globalThis.ImageData=class {constructor(data){this.data=data;}};
  t.after(()=>{if(previous)globalThis.ImageData=previous;else delete globalThis.ImageData;});
  const {view,requests,drawn,finish,configure,revise}=fixture(t,true,{rgba:true});
  t.after(()=>view.dispose());
  configure({documentId:'ink',visiblePixels:[[0,4096],[0,4096]],detailDelay:60_000});
  view.refresh();await finish(0,10);
  view.retryDetail();await finish(1,11,4096);
  const stroke={op:'image',action:'stroke',layerId:'color',target:'pixels',stroke:{radius:.001,stamps:[[.5,.5]]}};
  view.update(stroke);
  const {window}=requests[2].data;
  requests[2].resolve(new Response(new Uint8Array(window[2]**2*4).fill(21),{headers:{'X-Paint-Window':window.join(',')}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drawn.at(-1),21);
  revise(2);view.update(null,structuredClone(stroke));await finish(3,20);
  assert.equal(drawn.at(-1),21);
  revise(3);view.refresh();await finish(4,30);
  assert.equal(drawn.at(-1),30);
});

test('toggling the gamut warning redraws a held wide-gamut brush patch without issuing a preview request',async t=>{
  const {view,requests,drawn,finish,configure,revise}=fixture(t,true,{rgba:true});
  t.after(()=>view.dispose());
  configure({documentId:'p3',colorSpace:'display-p3',visiblePixels:[[0,4096],[0,4096]],detailDelay:60_000});
  view.refresh();await finish(0,10);
  view.retryDetail();await finish(1,11,4096);
  const stroke={op:'image',action:'stroke',layerId:'color',target:'pixels',stroke:{radius:.001,stamps:[[.5,.5]]}};
  view.update(stroke);
  const {window}=requests[2].data,pixels=new Uint8Array(window[2]**2*4);
  pixels.set([0,255,0,73]);
  requests[2].resolve(new Response(pixels,{headers:{'X-Paint-Window':window.join(',')}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drawn.at(-1),0);
  revise(2);view.update(null,structuredClone(stroke));await finish(3,20);
  configure({gamutWarning:true});view.displayChanged();
  assert.equal(drawn.at(-1),255);
  configure({gamutWarning:false});view.displayChanged();
  assert.equal(drawn.at(-1),0);
  assert.equal(requests.length,4);
});

test('switching layers rejects an older same-revision draft and targets the new visible region',async t=>{
  const {view,requests,drawn,finish,configure}=fixture(t,true,{rgba:true});
  t.after(()=>view.dispose());
  configure({documentId:'banner',visiblePixels:[[0,4096],[0,4096]],detailDelay:60_000,
    draftBounds:edit=>edit.layerId==='a'?[0,0,.02,.02]:[.75,.5,.78,.53]});
  view.refresh();await finish(0,7);
  view.retryDetail();await finish(1,8,4096);
  const opacity=layerId=>({op:'image',action:'updateLayer',documentId:'banner',layerId,patch:{opacity:.25}});
  view.update(opacity('a'));
  assert.deepEqual(requests[2].data.window,[0,0,256]);
  view.update(opacity('b'));
  assert.equal(requests[2].signal.aborted,true);
  await finish(2,99);
  assert.equal(drawn.at(-1),8);
  const [x,y,side]=requests[3].data.window;
  assert.ok(x<=3072 && x+side>=3195 && y<=2048 && y+side>=2171);
  assert.equal(requests[3].data.operation.layerId,'b');
});
