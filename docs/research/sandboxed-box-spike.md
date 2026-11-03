# Sandboxed Box runtime spike

Measured 2026-11-03 against `6b5a0ba406d48c43bbc5f288ef0112ab6d5d2c70`, the head of `docs/sandboxed-boxes` (PR #196). This is a throwaway runtime measurement, not a security audit or a product implementation.

## Answers

Normal QuickJS loads under Bun 1.4.4 without flags. Memory and interrupt limits work, synchronous guest calls work inside a SQLite transaction, and a Promise bridge overlaps host operations without asyncify. Both libfx native and WASM run a host-tool agent loop without flags. Race batching reduces boundary cost, but a 200-Stretch fold still blocks for about 562 ms on this host.

## Environment and method

- Bun `1.4.4` (`38afee6c8`), Linux x86_64, Intel Core i5-4460 at 3.20 GHz, four logical CPUs.
- `quickjs-emscripten@0.32.0`, default synchronous release WASM from `getQuickJS()`; no asyncify.
- `libfx@0.0.16`; npm's `latest` was also `0.0.16` when fetched. Each experiment has its own package and lockfile under `.scratch/spike/`.
- Initial load averages were 1.37, 0.69, 0.50. Other services share this machine. Heavy commands acquired `/tmp/ditzy-heavy.lock`; no experiment files used `/tmp`.
- No root dependency, source, full-suite, typecheck or e2e changes/runs. No paid provider calls. The fake provider bound only `127.0.0.1` on an ephemeral port. libfx used `durability: memory()` to avoid its default temporary session storage.

Race timings cover the actual JSON boundary: host stringify, QuickJS string creation, guest parse, hook, guest stringify, host string extraction and parse. Compiled guest dispatch functions are reused through `callFunction`, rather than compiling a new expression per hook. Native timings cover the pure function only. VM construction, bundling, synthetic history generation and equality checks are outside the timed region. One untimed warm-up runs each case; seven timed samples alternate forward/reverse method order. Every output is deep-equal to native output, including the next Stretch narrative and record. No failed timed calls occurred.

These are single-history, single-concurrency microbenchmarks. They do not measure a user request, database history loading, competing Boxes, Memory embeddings or production tail latency. The native fold is a trivial pointer selection, so sub-millisecond variation is not a useful throughput claim.

## QuickJS limits and synchronous capture

An 8 MiB runtime heap limit stopped repeated `new Array(10000).fill(42)` allocation with guest `InternalError: out of memory`. A subsequent `21*2` returned `42` in the same context. Raising the limit to 256 MiB allowed the later probes.

An interrupt handler returning true on its 101st check stopped `while(true){}` with guest `InternalError: interrupted` in 7.329 ms in the recorded run. Removing that handler allowed `21*2` to return `42` in the same context. This is a check-count experiment, not a calibrated 7 ms deadline or an interrupt-overhead benchmark. No production limit is selected by these measurements.

Inside `bun:sqlite`'s synchronous `db.transaction()` callback, `db.inTransaction` was true. The guest addition returned `42`, was not a Promise, and the callback inserted that value. Reading after commit returned `{ value: 42 }`. This establishes synchronous VM invocation inside a transaction, not the correctness of a future capability implementation.

## Promise bridge and cancellation

A host `wait` function creates a QuickJS deferred Promise, retains its host handle and starts a host timer. The guest calls `Promise.all([wait(100), wait(100)])`. The host resolves the deferreds and pumps `executePendingJobs()` every approximately 2 ms. Both host operations were active at once; elapsed time was 109.709 ms, both results were `"done"`, and the active map ended at zero. This demonstrates overlap rather than two sequential 100 ms waits.

A separate outstanding 1,000 ms wait was cancelled through its host-issued numeric handle: clear its timer, reject its deferred with `Error("aborted")`, dispose it and remove the map entry. After pumping jobs, the guest catch saw `"aborted"` and the map held zero handles. Context/runtime disposal completed without a leak assertion. This is bounded handle-lifecycle evidence, not a long-duration memory soak test or an AbortSignal crossing the boundary.

Returning a deferred handle transfers ownership to the callback machinery; the retained deferred therefore returns `handle.dup()`. The initial experiment also tried dumping an unsettled Promise as an ordinary value, which raised `QuickJSUseAfterFree` in the wrapper. The corrected probe ends scheduling expressions with `void 0` and observes guest state after pumping jobs. Unsettled Promises are not JSON results.

## Race fold and advance

The Bun browser bundle uses the actual `server-engine.ts` and local dependencies. A build plugin replaces the pure SDK `isNonEmpty` import with `a => a.length > 0`, so it pulls in no host SDK or Node imports. Eight seeded roster runners advance through real synthetic histories of 10, 50 and 200 Stretches. Course distance is `(N+10)*400` metres to keep every generated Stretch and the measured next advance active. These deliberately long courses are synthetic engine inputs, not claims about ordinary course lengths.

`foldRace` selects a matching full-state record. Each record includes replay accumulated so far. Per-call fold sends state, record and setup across JSON on every call. Batch fold sends all records and setup once, loops inside QuickJS, and serializes only the final state. Native fold runs the same reduction in Bun. Advance measures one additional Stretch at each history length, including its JSON round trip for QuickJS.

All times below are milliseconds, median [minimum, maximum] of seven samples.

| Stretches | Native fold | QuickJS per-call fold | QuickJS batch fold | Native advance | QuickJS advance |
|---|---|---|---|---|---|
| 10 | 0.006 [0.003, 0.014] | 5.764 [5.520, 7.249] | 1.980 [1.886, 2.148] | 0.226 [0.161, 1.618] | 2.011 [1.934, 2.280] |
| 50 | 0.006 [0.005, 0.008] | 117.967 [116.380, 130.233] | 36.636 [35.501, 40.233] | 0.168 [0.124, 0.235] | 4.588 [4.463, 5.839] |
| 200 | 0.013 [0.012, 0.015] | 1764.982 [1761.403, 1828.174] | 561.676 [560.137, 579.954] | 0.148 [0.114, 0.153] | 13.732 [13.537, 14.260] |

| Stretches | Final record JSON bytes | All records JSON bytes |
|---|---|---|
| 10 | 8,180 | 46,987 |
| 50 | 45,531 | 1,141,548 |
| 200 | 171,764 | 17,664,185 |

The benchmark VM heap limit was 512 MiB; the limit probes used separate contexts. The performance run installed no interrupt handler. This is not evidence that a small production heap or deadline can hold 200 cumulative records.

A separate 200-Stretch probe uses the same boundary but replaces the fold with `JSON.parse(json).records.at(-1)`, then serializes the final record. Its seven times were 762.667, 552.294, 553.479, 548.903, 555.845, 542.718 and 549.217 ms, median 552.294 ms. This is execution evidence that parsing/copying the payload dominates the 561.676 ms batch fold. It is not a CPU profile attributing individual allocations. A full echo of the 17.7 MB input back to the host measured 1,300.706 ms median [1,290.431, 1,312.994]. The fold does run, but its pointer-selection work is negligible beside transferring cumulative replay.

**Inference for tickets 01–02:** batch folds, bound input/output bytes before allocating guest strings, and choose heap/deadline budgets with long histories in mind. Batching alone does not establish an acceptable capture budget. About 562 ms of synchronous work inside capture is a remaining risk; the product latency budget is not specified. A generic fold implementation must preserve full hook semantics rather than assume every Box's fold can select the last record.

## libfx backend and agent loop

Forced `backend: "native"` reported `native` available, then completed the real agent turn. Forced `backend: "wasm"` reported `wasm-jspi` available and completed the same turn. Neither Bun invocation passed a JSPI or other runtime flag. Native is viable on this Linux host; this does not establish Windows or other platform support.

Only `read_contract` and `run_scenario` host tools were registered, both idempotent stubs. Exactly those two names appeared in the fake provider's tool definitions. The fake streamed one `run_scenario({})` tool call, then the text `Scenario passed.` on the next model request. Both backends made two requests, executed the stub once, and ended with `stopReason: "end_turn"`.

The events consumed from each `createFxAgent` turn were, in order:

```text
tool_start (call_1, run_scenario, {})
tool_end   (call_1, run_scenario, content={"ok":true}, isError=false)
text_delta (Scenario passed.)
```

The session checkpoint was 1,269 bytes for native and 1,270 bytes for WASM. These opaque checkpoint sizes describe this tiny conversation only; no persistence growth model or cross-version restore was measured.

For cancellation the fake accepts a third request and leaves the SSE body open. After that request reaches the endpoint, `session.cancel()` ends the turn with `stopReason: "cancelled"`: 0.978 ms native and 1.703 ms WASM in the recorded runs. The server is stopped and the agent closed afterwards. Cancellation during a running host tool and checkpoint restore are outside this ticket's experiment.

The observed request is OpenAI Chat Completions SSE, `POST /chat/completions`, with `model: "fake"`, `stream: true`, `stream_options: { include_usage: true }`, function tools and `max_tokens: 1024`. On the second request, messages contain the assistant's `tool_calls` and a `role: "tool"` message with `tool_call_id: "call_1"` and content `"{\"ok\":true}"`. The fake returns chunks with `object: "chat.completion.chunk"`, `choices[0].index: 0`, `delta.tool_calls` with an index/id/function name and JSON arguments, `finish_reason: "tool_calls"`, then a second response with text, `finish_reason: "stop"` and `data: [DONE]`. No credentials were needed for localhost.

Initial backend-only probes pointed at an unused localhost port. They reported backend availability but ended `HostStreamFailed`; that was the expected missing-provider failure, not successful agent-loop evidence. The scripted endpoint runs above establish loop execution.

## Reproduce

Run from the repository root at the recorded commit. Save the scripts below at their indicated paths. The package files are:

```sh
mkdir -p .scratch/spike/quickjs .scratch/spike/libfx
printf '%s\n' '{"private":true,"type":"module","dependencies":{"quickjs-emscripten":"0.32.0"}}' > .scratch/spike/quickjs/package.json
printf '%s\n' '{"private":true,"type":"module","dependencies":{"libfx":"0.0.16"}}' > .scratch/spike/libfx/package.json
flock /tmp/ditzy-heavy.lock bun install --cwd .scratch/spike/quickjs
flock /tmp/ditzy-heavy.lock bun install --cwd .scratch/spike/libfx
bun --version
uptime
nproc
uname -sm
lscpu
curl -Ls https://fx.sh/llms.txt -o .scratch/spike/libfx/llms.txt
curl -Ls https://registry.npmjs.org/libfx/latest -o .scratch/spike/libfx/npm-latest.json
flock /tmp/ditzy-heavy.lock bun .scratch/spike/quickjs/build.js
flock /tmp/ditzy-heavy.lock bun .scratch/spike/quickjs/run.js > .scratch/spike/quickjs/runtime-results.txt 2>&1
flock /tmp/ditzy-heavy.lock bun .scratch/spike/quickjs/race.js > .scratch/spike/quickjs/race-results.json
flock /tmp/ditzy-heavy.lock bun .scratch/spike/quickjs/profile.js > .scratch/spike/quickjs/profile-results.json
flock /tmp/ditzy-heavy.lock timeout 30s bun .scratch/spike/libfx/loop.js native > .scratch/spike/libfx/loop-native.txt 2>&1
flock /tmp/ditzy-heavy.lock timeout 30s bun .scratch/spike/libfx/loop.js wasm > .scratch/spike/libfx/loop-wasm.txt 2>&1
```

The scripts throw on missing records, mismatched outputs, missing loop events or unsuccessful libfx turns. The runtime probe prints its results and checks the transaction; inspect its limit, overlap and disposal output against the findings above.

### `.scratch/spike/quickjs/build.js`

```js
const root = process.cwd();
const result = await Bun.build({entrypoints:[root+'/src/boxes/race/server-engine.ts',root+'/src/boxes/race/shared-data.ts'],outdir:root+'/.scratch/spike/quickjs/bundle',target:'browser',plugins:[{name:'pure-sdk',setup(b){b.onResolve({filter:/^@\/box-sdk\/shared$/},()=>({path:'sdk',namespace:'pure'}));b.onLoad({filter:/.*/,namespace:'pure'},()=>({contents:'export const isNonEmpty = a => a.length > 0;',loader:'js'}));}}]});
if(!result.success) throw result.logs;
```

### `.scratch/spike/quickjs/run.js`

```js
import {getQuickJS} from 'quickjs-emscripten';
import {Database} from 'bun:sqlite';
import assert from 'node:assert/strict';
const Q=await getQuickJS(); const rt=Q.newRuntime(); const vm=rt.newContext();
function evaluate(code){const r=vm.evalCode(code);if(r.error){const e=vm.dump(r.error);r.error.dispose();throw Error(JSON.stringify(e));}const v=vm.dump(r.value);r.value.dispose();return v;}
console.log('load',evaluate('1+2'));
rt.setMemoryLimit(8*1024*1024);
try{evaluate('(()=>{const a=[]; while(true) a.push(new Array(10000).fill(42));})()')}catch(e){console.log('memory',e.message)}
console.log('after-memory',evaluate('21*2'));
rt.setMemoryLimit(256*1024*1024);let calls=0;rt.setInterruptHandler(()=>++calls>100);
let t=performance.now();try{evaluate('while(true){}')}catch(e){console.log('interrupt',e.message,'ms',performance.now()-t,'checks',calls)}
rt.removeInterruptHandler();console.log('after-interrupt',evaluate('21*2'));
const db=new Database(':memory:');db.exec('CREATE TABLE probe(value INTEGER)');
const sync=db.transaction(()=>{assert(db.inTransaction);const result=evaluate('((a,b)=>a+b)(20,22)');db.query('INSERT INTO probe VALUES (?)').run(result);return {result,inTransaction:db.inTransaction,promise:result instanceof Promise};})();console.log('sqlite',sync,db.query('SELECT * FROM probe').all());db.close();
const active=new Map();let maxActive=0;let next=0;
const host=vm.newFunction('wait',delay=>{const ms=vm.getNumber(delay);const deferred=vm.newPromise();const id=++next;const timer=setTimeout(()=>{const h=vm.newString('done');deferred.resolve(h);h.dispose();active.delete(id);deferred.dispose();},ms);active.set(id,{deferred,timer});maxActive=Math.max(maxActive,active.size);return deferred.handle.dup();});
vm.setProp(vm.global,'wait',host);host.dispose();
evaluate('globalThis.done=null; Promise.all([wait(100),wait(100)]).then(x=>done=x);void 0');t=performance.now();
while(evaluate('done===null')){await Bun.sleep(2);const r=rt.executePendingJobs();if(r.error)throw Error('jobs');}
console.log('overlap',{ms:performance.now()-t,maxActive,result:evaluate('done'),active:active.size});
evaluate('globalThis.cancelled=null; wait(1000).catch(e=>cancelled=e.message);void 0');
for(const [id,{deferred,timer}] of active){clearTimeout(timer);const e=vm.newError('aborted');deferred.reject(e);e.dispose();deferred.dispose();active.delete(id);}
rt.executePendingJobs();console.log('cancel',{result:evaluate('cancelled'),active:active.size});
vm.dispose();rt.dispose();console.log('disposed');
```

### `.scratch/spike/quickjs/race.js`

```js
import {getQuickJS} from 'quickjs-emscripten';
import * as engine from './bundle/server-engine.js';
import {initialRaceSetup,fillRaceField} from './bundle/shared-data.js';
import assert from 'node:assert/strict';
const Q=await getQuickJS(),rt=Q.newRuntime(),vm=rt.newContext();rt.setMemoryLimit(512*1024*1024);
const source=(await Bun.file(import.meta.dir+'/bundle/server-engine.js').text()).replace(/export \{[\s\S]*?\};?\s*$/,'');
function run(code){const r=vm.evalCode(code);if(r.error){const e=vm.dump(r.error);r.error.dispose();throw Error(JSON.stringify(e));}const value=vm.dump(r.value);r.value.dispose();return value;}
run(source+'\nglobalThis.foldRace=foldRace;globalThis.advanceRace=advanceRace;');
run('globalThis.dispatch=(name,json)=>JSON.stringify(globalThis[name](JSON.parse(json)));');
const dispatch=vm.getProp(vm.global,'dispatch');
const invoke=(name,arg)=>{const a=vm.newString(name),b=vm.newString(JSON.stringify(arg));const r=vm.callFunction(dispatch,vm.undefined,a,b);a.dispose();b.dispose();if(r.error){const error=vm.dump(r.error);r.error.dispose();throw Error(JSON.stringify(error));}const json=vm.getString(r.value);r.value.dispose();return JSON.parse(json);};
run('globalThis.foldOne=({state,record,setup})=>foldRace(state,record,setup);globalThis.foldBatch=({records,setup})=>records.reduce((s,r)=>foldRace(s,r,setup),null);');
const result=[];
for(const n of [10,50,200]){
 const setup={...initialRaceSetup,raceId:'spike',phase:'running',course:{...initialRaceSetup.course,distance:(n+10)*400},slots:fillRaceField([],[],'field')};
 let state=null;const records=[];
 for(let i=0;i<n;i++){const turn=engine.advanceRace({setup,state,seed:`stretch-${i}`,intent:'respond',moves:[]});assert(turn?.record);state=turn.record;records.push(state);}
 assert.equal(state.stretch,n);assert.equal(state.standings.length,8);
 const input={setup,state,seed:'next',intent:'respond',moves:[]};
 const nativeAdvance=engine.advanceRace(input);assert.deepEqual(invoke('advanceRace',input),nativeAdvance);
 run('globalThis.echo=x=>x;');
 const jobs={transfer:()=>invoke('echo',{records,setup}),nativeFold:()=>records.reduce((s,r)=>engine.foldRace(s,r,setup),null),perCall:()=>{let s=null;for(const record of records)s=invoke('foldOne',{state:s,record,setup});return s;},batch:()=>invoke('foldBatch',{records,setup}),nativeAdvance:()=>engine.advanceRace(input),guestAdvance:()=>invoke('advanceRace',input)};
 for(const [name,fn] of Object.entries(jobs))assert.deepEqual(fn(),name==='transfer'?{records,setup}:name.includes('Advance')?nativeAdvance:state);
 const samples=Object.fromEntries(Object.keys(jobs).map(k=>[k,[]]));
 for(let iteration=0;iteration<7;iteration++)for(const name of iteration%2?Object.keys(jobs).reverse():Object.keys(jobs)){
  const start=performance.now();const out=jobs[name]();const ms=performance.now()-start;assert.deepEqual(out,name==='transfer'?{records,setup}:name.includes('Advance')?nativeAdvance:state);samples[name].push(ms);
 }
 result.push({stretches:n,recordBytes:Buffer.byteLength(JSON.stringify(state)),batchBytes:Buffer.byteLength(JSON.stringify(records)),samples});
}
console.log(JSON.stringify(result,null,2));dispatch.dispose();vm.dispose();rt.dispose();
```

### `.scratch/spike/quickjs/profile.js`

```js
import {getQuickJS} from 'quickjs-emscripten';
import {advanceRace} from './bundle/server-engine.js';
import {initialRaceSetup,fillRaceField} from './bundle/shared-data.js';
const setup={...initialRaceSetup,raceId:'spike',phase:'running',course:{...initialRaceSetup.course,distance:84000},slots:fillRaceField([],[],'field')};let state=null;const records=[];for(let i=0;i<200;i++){state=advanceRace({setup,state,seed:`stretch-${i}`,intent:'respond',moves:[]}).record;records.push(state);}
const rt=(await getQuickJS()).newRuntime(),vm=rt.newContext();rt.setMemoryLimit(512*1024*1024);vm.evalCode('globalThis.last=json=>JSON.stringify(JSON.parse(json).records.at(-1))').value.dispose();const fn=vm.getProp(vm.global,'last');const samples=[];for(let i=0;i<7;i++){const start=performance.now();const str=vm.newString(JSON.stringify({records,setup}));const r=vm.callFunction(fn,vm.undefined,str);if(r.error)throw Error(vm.dump(r.error));const out=JSON.parse(vm.getString(r.value));str.dispose();r.value.dispose();samples.push(performance.now()-start);if(out.stretch!==200)throw Error('wrong output');}console.log(JSON.stringify(samples));fn.dispose();vm.dispose();rt.dispose();
```

### `.scratch/spike/libfx/loop.js`

```js
import {createFxAgent,memory,getBackendInfo} from 'libfx';
import assert from 'node:assert/strict';
const backend=process.argv[2]??'native';let requestCount=0,toolRuns=0,held=false;const requests=[];
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){assert.equal(new URL(req.url).pathname,'/chat/completions');const body=await req.json();requests.push(body);requestCount++;
if(held)return new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'text/event-stream'}});
const tool=body.messages.some(m=>m.role==='tool');
const chunks=tool?[{delta:{role:'assistant',content:'Scenario passed.'},finish_reason:null},{delta:{},finish_reason:'stop'}]:[{delta:{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'run_scenario',arguments:'{}'}}]},finish_reason:null},{delta:{},finish_reason:'tool_calls'}];
return new Response(chunks.map(c=>'data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',created:1,model:'fake',choices:[{index:0,...c}]})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}});
const agent=createFxAgent({backend,durability:memory(),model:'fake',provider:{name:'local',baseUrl:`http://127.0.0.1:${server.port}`,models:{fake:{contextWindow:32768,maxOutputTokens:1024,supportsToolUse:true}}},tools:['read_contract','run_scenario'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{},additionalProperties:false},idempotent:true,execute:()=>{toolRuns++;return {ok:true};}}))});
try{
console.log('backend',await getBackendInfo({backend}));const session=agent.session();const turn=session.prompt('Run the scenario.');const events=[];for await(const event of turn)events.push(event);const result=await turn.result;console.log('loop',JSON.stringify({events,result,requestCount,toolRuns,checkpointBytes:(await session.checkpoint()).byteLength,requests},null,2));assert.equal(result.stopReason,'end_turn');assert.equal(toolRuns,1);for(const type of ['text_delta','tool_start','tool_end'])assert(events.some(e=>e.type===type));
held=true;const before=requestCount;const cancel=session.prompt('Wait.');while(requestCount===before)await Bun.sleep(5);const start=performance.now();await session.cancel();const cancelled=await cancel.result;console.log('cancel',JSON.stringify({ms:performance.now()-start,result:cancelled}));assert.equal(cancelled.stopReason,'cancelled');
}finally{await agent.close();server.stop(true);}
```

## Sources

- [Spike brief](../tickets/sandboxed-boxes/00-runtime-spike.md).
- [Prior fit research, including performance risks](sandbox-box-landmark-fit.md).
- [Creator Mode background](deepseek-harness-creator-mode.md).
- [quickjs-emscripten Promise and lifetime documentation](https://github.com/justjake/quickjs-emscripten#promises), cross-checked against the installed 0.32.0 README and the runtime probes.
- [Official fx documentation index](https://fx.sh/llms.txt), [libfx providers](https://fx.sh/docs/lib/providers.md), [host tools](https://fx.sh/docs/lib/tools.md), [Node backends](https://fx.sh/docs/lib/node.md), [checkpoints](https://fx.sh/docs/lib/checkpoints.md). API usage was checked against the installed 0.0.16 README and declarations, then exercised above.
- [npm libfx metadata](https://registry.npmjs.org/libfx/latest), fetched on the measurement date.
