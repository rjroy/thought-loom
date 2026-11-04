import { OpenCode } from '@opencode/client';
import { prepareIsolatedLaunch } from './isolation';
import { preflightExecutable, requireOptIn } from './native-binary';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, lstat, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { startDaemon, type RunningDaemon } from '../../src/daemon/runtime';
import { Database } from 'bun:sqlite';
import { installTerminationCleanup } from './lifecycle';
type RunView = { id:string; status:string; confirmedThoughtIds:string[]; responseId:string | null };

const bin = requireOptIn(process.env);
let root = '';
let rootPromise: Promise<string> | undefined;
const result: Record<string, unknown> = { result: 'FAIL', binary: bin, command: [bin,'serve','--hostname','127.0.0.1','--port','0'], steps: [], cleanup: {} };
const lifecycle = installTerminationCleanup({actionTimeoutMs: 10_000, onError: error => { result.result='FAIL'; (result.cleanup as Record<string,unknown>).actionFailure=String(error); }, onSignal: signal => { result.result='FAIL'; result.signal=signal; }});
const steps = result.steps as unknown[];
let child: ReturnType<typeof spawn> | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let proxy: Server | undefined;
let daemon: RunningDaemon | undefined;
let daemonStarting: Promise<RunningDaemon> | undefined;
let acquisition: Promise<unknown> | undefined;
let output = '';
const providerRequests: unknown[] = [];
const nativeCalls: unknown[] = [];
let releaseHeld: (()=>void) | undefined;
let holdSeen=false;
let dropped: {path:string,status:number,body:unknown}|undefined;
const inspect = async (p: string) => { try { const s = await lstat(p); return s.isSymbolicLink() ? 'symlink' as const : s.isDirectory() ? 'directory' as const : s.isFile() ? 'file' as const : 'error' as const; } catch(e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'error' as const; } };
const delay = (n: number) => new Promise(resolve => setTimeout(resolve,n));
async function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)),ms); })]); } finally { clearTimeout(timer!); } }
const cleanup = result.cleanup as Record<string,unknown>;
function register(name: string, action: () => Promise<void>): void {
  lifecycle.add(async () => { try { await action(); } catch (error) { cleanup[`${name}Error`] = String(error); result.result='FAIL'; throw error; } });
}
// Register before acquiring anything; closures capture only resources owned by this invocation.
register('release', async () => { releaseHeld?.(); });
register('acquisition', async () => { if (acquisition) await acquisition.catch(() => undefined); });
register('daemon', async () => { if (daemonStarting) await daemonStarting.catch(() => undefined); if (daemon) await daemon.stop(); cleanup.daemonStopped=true; });
const descendants:number[]=[];
register('nativeAudit', async () => {
  if (!child?.pid) return;
  const collect=async(parent:number):Promise<void>=>{try {const value=await readFile(`/proc/${parent}/task/${parent}/children`,'utf8'); for(const next of value.trim().split(/\s+/).filter(Boolean).map(Number)){descendants.push(next); await collect(next);}} catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
  await collect(child.pid);
  cleanup.observedDescendants=descendants;
});
register('native', async () => {
  if (!child?.pid) return;
  const pid=child.pid; let termError:unknown;
  try { process.kill(-pid,'SIGTERM'); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') termError=e; }
  await delay(1500);
  try { process.kill(-pid,0); process.kill(-pid,'SIGKILL'); await delay(200); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  try { process.kill(-pid,0); cleanup.processGroupGone=false; } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; cleanup.processGroupGone=true; }
  cleanup.pid=pid; const remaining:number[]=[];
  for(const descendant of descendants){try{process.kill(descendant,0); remaining.push(descendant);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
  cleanup.descendantsStillPresent=remaining;
  if (termError || !cleanup.processGroupGone || remaining.length) throw new Error(`Native cleanup verification failed${termError ? `: ${String(termError)}` : ''}`);
});
register('proxy', async () => { if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve,reject) => proxy?.close(error => error ? reject(error) : resolve())); } cleanup.proxyStopped=true; });
register('provider', async () => { if (provider) await Promise.resolve(provider.stop(true)); cleanup.providerStopped=true; });
register('root', async () => {
  if (rootPromise) root = await rootPromise;
});
const ownedDirectories = ['home','xdg-config','data','cache','state','tmp','config','db','workspace','owned-external'];
for (const d of ownedDirectories) register(`remove-${d}`, async () => { if (root) await rm(join(root,d),{recursive:true,force:true}); });
register('receipts', async () => {
  if (!root) return;
  cleanup.ownedDataRemoved=ownedDirectories.every(d => cleanup[`remove-${d}Error`] === undefined) && cleanup.actionFailure === undefined;
  await writeFile(join(root,'native-output.log'),output.replace(/opencode:[^\s]+/g,'opencode:[redacted]'));
  await writeFile(join(root,'provider-receipt.json'),JSON.stringify(providerRequests,null,2));
  await writeFile(join(root,'native-wire.json'),JSON.stringify(nativeCalls,null,2));
  await writeFile(join(root,'receipt.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
});
try {
  const hash = await preflightExecutable(bin); lifecycle.throwIfStopping(); result.sha256=hash;
  assert.equal(await realpath('/tmp/opencode'),'/tmp/opencode');
  assert.equal(await inspect('/etc/opencode'),'missing');
  lifecycle.throwIfStopping();
  rootPromise=mkdtemp('/tmp/opencode/thoughtloom-native-acceptance-'); acquisition=rootPromise; root=await rootPromise; result.root=root; lifecycle.throwIfStopping();
  for (const d of ['home','xdg-config','data','cache','state','tmp','config','db','workspace','owned-external']) { acquisition=mkdir(join(root,d),{mode:0o700}); await acquisition; lifecycle.throwIfStopping(); }
  acquisition=writeFile(join(root,'empty.gitconfig'),'',{mode:0o600}); await acquisition; lifecycle.throwIfStopping();
  provider = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/v1/chat/completions') return new Response('invalid fixture route',{status:404});
    const text = await req.text(); if (text.length > 4_000_000) return new Response('too large',{status:413});
    const body = JSON.parse(text); if (body.model !== 'fixture-model' || !Array.isArray(body.messages)) return new Response('invalid fixture input',{status:400});
    providerRequests.push({model:body.model, messages:body.messages, tools:body.tools?.map((x: { function?: {name?: string} }) => x.function?.name)});
    const frame = (delta: object, finish: string | null) => `data: ${JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta,finish_reason:finish}],...(finish ? {usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}} : {})})}\n\n`;
    const title = body.messages.some((m: {role:string,content:unknown})=>m.role==='system' && typeof m.content==='string' && m.content.startsWith('You name conversations'));
    const userMessages = body.messages.filter((m: {role:string})=>m.role==='user');
    const inputs = userMessages.flatMap((m: {content:unknown})=> { try { const v=JSON.parse(String(m.content)); return v && typeof v==='object' ? [v] : []; } catch { return []; } });
    const job=inputs.find((x: {kind:string})=>x.kind==='job');
    const last=inputs.at(-1);
    if (!title && !job) { providerRequests.push({error:'missing job',inputs}); return new Response('fixture missing job',{status:400}); }
    const request=(capability:string,args:object)=>({version:1,kind:'request',request:{capability,arguments:args}});
    const complete=(reply:string)=>({version:1,kind:'complete',reply});
    let output:unknown;
    if (!title && job.context.job.kind==='evolve' && JSON.stringify(job.context).includes('fixture-stop-case') && last.kind==='capability-result' && last.request.capability==='development') {
      holdSeen=true; await new Promise<void>(resolve=>{ releaseHeld=resolve; });
    }
    if (title) output='Fixture native title';
    else if (job.context.job.kind==='weave') output=last.kind==='job' ? request('title-fill',{title:'Fixture generated title'}) : complete('No findings.');
    else if (last.kind==='job') output=request('readThought',{id:job.context.job.contributionId});
    else if (last.request.capability==='readThought') output=request('development',{parentId:job.context.job.contributionId,text:'fixture development',sourceIds:[]});
    else if (last.request.capability==='development') output=complete('fixture human reply');
    else throw new Error('unexpected capability');
    return new Response(frame({content:typeof output==='string'?output:JSON.stringify(output)},null)+frame({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const origin = `http://127.0.0.1:${provider.port}`;
  const config = JSON.stringify({model:'fixture-provider/fixture-model',update:'disable',share:'disabled',snapshots:false,providers:{'fixture-provider':{env:[],package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`${origin}/v1`,apiKey:'fixture-only'},models:{'fixture-model':{type:'chat',capabilities:{tools:true,input:['text'],output:['text']},limit:{context:131072,output:2048}}}}}});
  await writeFile(join(root,'native-config.redacted.json'),JSON.stringify(JSON.parse(config),null,2).replace('fixture-only','[fixture-token]'));
  const paths = {HOME:join(root,'home'),OPENCODE_TEST_HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'xdg-config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache'),XDG_STATE_HOME:join(root,'state'),TMPDIR:join(root,'tmp'),OPENCODE_CONFIG_DIR:join(root,'config'),OPENCODE_DB:join(root,'db/opencode.db'),GIT_CONFIG_GLOBAL:join(root,'empty.gitconfig')};
  const password = randomBytes(24).toString('hex');
  const spec = await prepareIsolatedLaunch({root,cwd:join(root,'workspace'),paths,config,providerOrigin:origin,password,host:'127.0.0.1',port:0,hostEnvironment:{OPENCODE_TEST_BINARY:bin}},inspect);
  lifecycle.throwIfStopping();
  child = spawn(spec.executable,spec.args,{cwd:spec.cwd,env:spec.env,detached:true,stdio:['ignore','pipe','pipe']});
  const exit = new Promise<{code:number|null,signal:NodeJS.Signals|null}>(resolve => child?.once('exit',(code,signal)=>resolve({code,signal})));
  child.stdout?.on('data', chunk => { output=(output+String(chunk)).slice(-200000); }); child.stderr?.on('data',chunk => { output=(output+String(chunk)).slice(-200000); });
  const nativeUrl = await bounded((async () => { while(true) { const m = /(?:^|\n)server listening on (http:\/\/127\.0\.0\.1:([1-9]\d{0,4}))\r?\n/.exec(output); if (m && ![3000,3001,9443,4173,4317,48763].includes(Number(m[2]))) return m[1]; if (child?.exitCode !== null) throw new Error(`native exited at startup: ${output}`); await delay(50); } })(),30000,'native readiness');
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const client = OpenCode.make({baseUrl:nativeUrl,headers:{authorization:auth}});
  const identity = await client.server.info({signal:AbortSignal.timeout(10000)}); assert.equal(identity.pid,child.pid); assert.equal(identity.version,'2.2.5'); steps.push({op:'identity',identity});
  lifecycle.throwIfStopping();
  proxy = createServer(async (req,res)=>{
    try {
      const chunks:Buffer[]=[]; for await(const chunk of req)chunks.push(Buffer.from(chunk)); const data=Buffer.concat(chunks); const path=req.url??'/';
      const upstream=await fetch(`${nativeUrl}${path}`,{method:req.method,headers:{authorization:auth,...(data.length?{'content-type':'application/json'}:{})},...(data.length?{body:data}:{})});
      const text=await upstream.text(); const parsed=text ? (()=>{try{return JSON.parse(text)}catch{return text}})():null;
      const body=data.length?JSON.parse(data.toString()):null;
      nativeCalls.push({method:req.method,path,body,status:upstream.status,response:parsed});
      if (!dropped && req.method==='POST' && /\/prompt$/.test(path) && JSON.stringify(body).includes('fixture-lost-ack-case')) { dropped={path,status:upstream.status,body:parsed}; req.socket.destroy(); return; }
      res.writeHead(upstream.status,upstream.status===204?{}:{'content-type':'application/json'}); res.end(text);
    } catch(e) { res.destroy(e instanceof Error ? e : new Error(String(e))); }
  });
  await bounded(new Promise<void>((resolve,reject)=>proxy?.once('error',reject).listen(0,'127.0.0.1',resolve)),5000,'proxy listen');
  const proxyAddress=proxy.address(); assert(proxyAddress && typeof proxyAddress!=='string'); const proxyUrl=`http://127.0.0.1:${proxyAddress.port}`;
  const token='fixture-user-012345678901234567890123456789';
  const agentToken='fixture-agent-01234567890123456789012345678';
  const appEvents: unknown[]=[];
  const appConfig={dbPath:join(root,'db','app.sqlite'),port:0,credentials:{user:token,ai:agentToken},agent:{service:{url:proxyUrl},directory:join(root,'workspace'),model:{providerID:'fixture-provider',id:'fixture-model'},effort:{quick:null,standard:null,thorough:null}}};
  const start=()=>{ lifecycle.throwIfStopping(); daemonStarting=startDaemon(appConfig,event=>appEvents.push(event),{resolveAgentService:async()=>({url:proxyUrl,headers:{authorization:auth}})}).then(value => {daemon=value; return value;}); return daemonStarting; };
  daemon = await start();
  const call=async(path:string,method='GET',data?:unknown)=>{ lifecycle.throwIfStopping(); const response=await fetch(new URL(path,daemon!.url),{method,headers:{authorization:`Bearer ${token}`,...(data===undefined?{}:{'content-type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(5000)}); return {status:response.status,data:await response.json()}; };
  const until=async(label:string,fn:()=>Promise<unknown>)=>{ const end=Date.now()+45000; while(Date.now()<end){lifecycle.throwIfStopping(); const value=await fn(); if(value)return value; await delay(100);} throw new Error(`timeout ${label}`); };
  const captured=await call('/thoughts','POST',{text:'fixture original'}); assert.equal(captured.status,201); const rootId=captured.data.id;
  const titled=await until('weave title',async()=>{const r=await call(`/thoughts/${rootId}`); return r.data.title==='Fixture generated title' ? r.data : null;}); steps.push({op:'weave title fill',thought:titled});
  const admission=await call(`/thoughts/${rootId}/evolve`,'POST',{text:'fixture question'}); assert.equal(admission.status,201); const runId=admission.data.run.id; const contributionId=admission.data.contribution.id; steps.push({op:'evolve admission',admission:admission.data});
  const view=await until('evolve completion',async()=>{const r=await call(`/runs/${runId}`); if(r.data.status==='failed'||r.data.status==='interrupted') throw new Error(`evolve ${r.data.status}`); return r.data.status==='completed'?r.data:null;}) as RunView;
  assert.equal(view.confirmedThoughtIds.length,1); const thought=await call(`/thoughts/${view.confirmedThoughtIds[0]}`); const response=await call(`/responses/${view.responseId}`);
  assert.equal(thought.data.text,'fixture development'); assert.equal(thought.data.parentId,contributionId); assert.equal(thought.data.author,'ai'); assert.equal(response.data.text,'fixture human reply'); assert.equal(response.data.state,'complete'); assert.equal(response.data.role,'addendum'); assert.deepEqual(response.data.thoughtIds,view.confirmedThoughtIds);
  steps.push({op:'application completed evolve',view,thought:thought.data,response:response.data});
  const named=await call('/thoughts','POST',{text:'fixture original pre-titled',title:'User retained title'}); assert.equal(named.status,201); const namedId=named.data.id;
  const namedRun=await until('named weave settled',async()=>{const db=new Database(appConfig.dbPath,{readonly:true}); try {return db.query("SELECT id,status FROM runs WHERE kind='weave' AND weave_subject_id=? AND status='completed'").get(namedId);} finally{db.close();}}) as {id:string,status:string};
  const namedDb=new Database(appConfig.dbPath,{readonly:true}); let namedReceipts: {result_json:string}[]; let namedIssued: unknown[];
  try { namedReceipts=namedDb.query('SELECT result_json FROM run_operation_receipts WHERE run_id=?').all(namedRun.id) as {result_json:string}[]; namedIssued=namedDb.query('SELECT thought_id FROM run_issued_thoughts WHERE run_id=?').all(namedRun.id); } finally {namedDb.close();}
  assert(namedReceipts.some(r=>{const value=JSON.parse(r.result_json); return value.type==='title-fill' && value.status==='unchanged';})); assert.equal(namedIssued.length,0);
  const namedRead=await call(`/thoughts/${namedId}`); assert.equal(namedRead.data.title,'User retained title'); steps.push({op:'weave no overwrite and no findings',run:namedRun,receipts:namedReceipts.map(r=>JSON.parse(r.result_json)),issued:namedIssued,thought:namedRead.data});
  const stopAdmission=await call(`/thoughts/${rootId}/evolve`,'POST',{text:'fixture-stop-case'}); const stopId=stopAdmission.data.run.id;
  await until('held provider',async()=>holdSeen);
  const beforeStop=await call(`/runs/${stopId}`); assert.equal(beforeStop.data.confirmedThoughtIds.length,1);
  const stopped=await call(`/runs/${stopId}/stop`,'POST',{}); assert.equal(stopped.data.status,'interrupted');
  const settled=await until('native cancellation settled',async()=>{const db=new Database(appConfig.dbPath,{readonly:true}); try {const row=db.query('SELECT cancellation_state FROM runs WHERE id=?').get(stopId) as {cancellation_state:string}; return row?.cancellation_state==='settled'?row:null;} finally{db.close();}});
  assert(nativeCalls.some((c:any)=>c.method==='POST' && c.path.includes('/interrupt?resume=false') && c.response?.interrupted===true));
  releaseHeld?.(); await delay(1000); const afterStop=await call(`/runs/${stopId}`); assert.equal(afterStop.data.status,'interrupted'); assert.deepEqual(afterStop.data.confirmedThoughtIds,beforeStop.data.confirmedThoughtIds); assert.equal(afterStop.data.responseId,null);
  const stopDb=new Database(appConfig.dbPath,{readonly:true}); let stopIssued: {thought_id:string}[]; try {stopIssued=stopDb.query('SELECT thought_id FROM run_issued_thoughts WHERE run_id=?').all(stopId) as typeof stopIssued;} finally {stopDb.close();} assert.equal(stopIssued.length,1); assert.equal(stopIssued[0].thought_id,beforeStop.data.confirmedThoughtIds[0]);
  steps.push({op:'stop after confirmed development',before:beforeStop.data,stopped:stopped.data,after:afterStop.data,issued:stopIssued,cancellation:settled});
  const uncertain=await call(`/thoughts/${rootId}/evolve`,'POST',{text:'fixture-lost-ack-case'}); const uncertainId=uncertain.data.run.id;
  await until('native lost acknowledgement',async()=>dropped??null);
  const preRestartDb=new Database(appConfig.dbPath,{readonly:true}); let preRestart: {position:number,prompt_id:string,state:string}[];
  try {preRestart=preRestartDb.query('SELECT position,prompt_id,state FROM run_steps WHERE run_id=? ORDER BY position').all(uncertainId) as typeof preRestart;} finally {preRestartDb.close();}
  assert.equal(preRestart.length,1); assert(['submitting','uncertain'].includes(preRestart[0].state)); assert.equal(preRestart[0].prompt_id,(dropped!.body as any).data.id);
  await daemon.stop(); daemon=undefined; daemon=await start();
  const resumed=await until('restart recovery',async()=>{const r=await call(`/runs/${uncertainId}`); if(r.data.status==='failed'||r.data.status==='interrupted')throw new Error(`restart ${r.data.status}`); return r.data.status==='completed'?r.data:null;}) as RunView;
  const droppedPath=dropped!.path; const samePromptCalls=nativeCalls.filter((c:any)=>c.method==='POST'&&c.path===droppedPath&&c.body?.id===(dropped!.body as any).data.id);
  assert.equal(samePromptCalls.length,1); assert.equal(resumed.confirmedThoughtIds.length,1);
  const restartDb=new Database(appConfig.dbPath,{readonly:true}); let issued:unknown[]; try { issued=restartDb.query('SELECT thought_id FROM run_issued_thoughts WHERE run_id=?').all(uncertainId); } finally {restartDb.close();} assert.equal(issued.length,1);
  assert(nativeCalls.some((c:any)=>c.method==='GET' && c.path.includes('/message?') && c.path.includes('cursor=')));
  steps.push({op:'lost acknowledgement daemon restart',dropped,preRestart,resumed,issued,identicalPromptPostCount:samePromptCalls.length,actualCursorContinuationObserved:true});
  result.result='PASS';
} catch(e) { result.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
finally {
  try { await lifecycle.cleanup(); } catch(error) { console.error('[fixture] cleanup failed',error); result.result='FAIL'; }
  finally { lifecycle.dispose(); }
  if(result.result!=='PASS') process.exitCode=1;
}
