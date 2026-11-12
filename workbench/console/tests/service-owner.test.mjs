import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {readServiceOwner} from '../service-owner.mjs';

const moduleUrl=new URL('../service-owner.mjs',import.meta.url).href;
const ownerCode=`
  import {acquireServiceProfile} from ${JSON.stringify(moduleUrl)};
  try{
    const release=await acquireServiceProfile(process.argv[1],process.argv[2],()=>process.exit(3));
    console.log('ready');
    process.stdin.resume();
    process.stdin.on('end',release);
  }catch(error){console.error(error.message);process.exitCode=1;}
`;

function start(data,port){
  const child=spawn(process.execPath,['--input-type=module','--eval',ownerCode,data,'http://127.0.0.1:'+port],
    {stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',errors='';
  child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);
  child.stderr.setEncoding('utf8').on('data',chunk=>errors+=chunk);
  const done=once(child,'close');
  return {child,done,async ready(){
    for(let i=0;i<200;i++){
      if(output.includes('ready'))return true;
      if(child.exitCode!==null||child.signalCode!==null){await done;return false;}
      await delay(25);
    }
    throw Error('Timed out starting isolated service lease: '+errors);
  },error:()=>errors};
}

test('one service owns a profile and forced exit releases the OS lock',{timeout:20000},async()=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'阿拉克涅 目录锁-'));
  const file=path.join(data,'server-lock.json'),children=[];
  try{
    // Upgrade from a truncated record left by an older launcher.
    await fs.writeFile(file,'{"pid":');
    const competitors=[start(data,18921),start(data,18922)];
    children.push(...competitors);
    const ready=await Promise.all(competitors.map(process=>process.ready()));
    assert.equal(ready.filter(Boolean).length,1);
    const winner=competitors[ready.indexOf(true)],loser=competitors[ready.indexOf(false)];
    assert.equal(readServiceOwner(file).pid,winner.child.pid);
    assert.match(loser.error(),/已有控制台使用该数据目录/);
    winner.child.kill('SIGKILL');
    await winner.done;
    const resumed=start(data,18923);children.push(resumed);
    assert.equal(await resumed.ready(),true,resumed.error());
    assert.equal(readServiceOwner(file).pid,resumed.child.pid);
    resumed.child.stdin.end();
    assert.equal((await resumed.done)[0],0);
    assert.equal(readServiceOwner(file),null);
  }finally{
    for(const {child,done} of children){
      if(child.exitCode===null&&child.signalCode===null)child.kill();
      await done;
    }
    await fs.rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
