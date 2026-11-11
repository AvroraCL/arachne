import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';

// Keep large registered model and UV files off the HTTP thread's synchronous
// path. Limit each synchronous hash update and stop reading on cancellation.
export async function sha256File(file,{signal,inspectHead}={}){
  const digest=createHash('sha256');
  let checked=false;
  for await(const bytes of createReadStream(file,{signal,highWaterMark:512*1024})){
    if(inspectHead&&!checked){inspectHead(bytes);checked=true;}
    digest.update(bytes);
  }
  if(inspectHead&&!checked)inspectHead(Buffer.alloc(0));
  return digest.digest('hex');
}
