import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

test('job recovery isolates malformed records and preserves the original bytes', async t=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'arachne-job-recovery-'));
  t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  const env={...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1'};
  const project=(id)=>{
    const folder=path.join(data,'projects',id);
    fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'project.json'),JSON.stringify({id,name:id,source:{},revision:0,workflowType:'pbr_paint'}));
    return folder;
  };
  const mixed=project('mixed'),other=project('other');
  function write(folder,id,status,raw){
    const parent=path.join(folder,'jobs',id);
    fs.mkdirSync(parent,{recursive:true});
    const file=path.join(parent,'job.json');
    const projectId=path.basename(folder);
    fs.writeFileSync(file,raw??JSON.stringify({id,projectId,type:'paint-backup',
      status,revision:0,stage:'任务',created:'2025-01-01T00:00:00Z',
      ...(status==='completed'?{archiveUrl:`/api/projects/${projectId}/jobs/${id}/files/backup/project.zip`}:{})}));
    return file;
  }
  const truncated=write(mixed,'truncated',null,'{"id":');
  const incomplete=write(mixed,'incomplete',null,'{"status":"completed"}');
  write(mixed,'no-output',null,JSON.stringify({id:'no-output',projectId:'mixed',status:'completed',
    type:'paint-backup',revision:0,stage:'已完成',created:'2025-01-01T00:00:00Z'}));
  write(mixed,'finished','completed');
  write(mixed,'active','running');
  write(other,'waiting','queued');
  const program=`
    import {recover,listJobs,getJob} from './jobs.mjs';
    recover();
    console.log(JSON.stringify({mixed:listJobs('mixed'),other:listJobs('other'),direct:getJob('mixed','truncated')}));
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{
    cwd:path.resolve(import.meta.dirname,'..'),env
  });
  let stdout='',stderr='';
  child.stdout.on('data',bytes=>stdout+=bytes);
  child.stderr.on('data',bytes=>stderr+=bytes);
  assert.equal((await once(child,'close'))[0],0,stderr);
  const {mixed:jobs,other:otherJobs,direct}=JSON.parse(stdout);
  assert.deepEqual(Object.fromEntries(jobs.map(job=>[job.id,job.status])),
    {active:'interrupted',finished:'completed',incomplete:'corrupt','no-output':'corrupt',truncated:'corrupt'});
  assert.equal(otherJobs[0].status,'interrupted');
  assert.match(direct.error,/JSON 格式无效/);
  assert.match(stderr,/incomplete.*字段缺失/);
  assert.match(stderr,/truncated.*JSON/);
  assert.equal(fs.readFileSync(truncated,'utf8'),'{"id":');
  assert.equal(fs.readFileSync(incomplete,'utf8'),'{"status":"completed"}');
});
