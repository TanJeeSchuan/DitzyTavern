import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'ditzy-sink-profile-'));
const artifactUrl = pathToFileURL(output + '/');
console.log(JSON.stringify({ artifacts: output, runtime: Bun.version }));
const source = await Bun.file(join(repo, 'src/server/model-client/model-fetch.ts')).text();
const sinkSource = source
  .replace('const chunks: Uint8Array[] = [];', 'const sink = new Bun.ArrayBufferSink();')
  .replace('total += next.value.byteLength;\n\t\t\tchunks.push(next.value);', 'sink.write(next.value.subarray(0, maxBytes - total));\n\t\t\ttotal += next.value.byteLength;')
  .replaceAll('joinBytes(chunks, maxBytes)', 'new Uint8Array(sink.end())')
  .replaceAll('joinBytes(chunks, total)', 'new Uint8Array(sink.end())')
  .split('\nfunction joinBytes')[0].trimEnd() + '\n';
assert.notEqual(sinkSource, source);
for (const [side, contents] of Object.entries({baseline: source, candidate: sinkSource,
  sink64k: sinkSource.replace('const sink = new Bun.ArrayBufferSink();', 'const sink = new Bun.ArrayBufferSink();\n\tsink.start({ highWaterMark: Math.min(maxBytes, 64 * 1024) });'),
  sinkCap: sinkSource.replace('const sink = new Bun.ArrayBufferSink();', 'const sink = new Bun.ArrayBufferSink();\n\tsink.start({ highWaterMark: maxBytes });'),
})) await Bun.write(join(output, side + '.ts'), contents);
const { readBoundedResponse: baseline, fetchWithTimeout } = await import(pathToFileURL(join(output,'baseline.ts')).href);
const { readBoundedResponse: candidate } = await import(pathToFileURL(join(output,'candidate.ts')).href);
const { readBoundedResponse: sink64k } = await import(pathToFileURL(join(output,'sink64k.ts')).href);
const { readBoundedResponse: sinkCap } = await import(pathToFileURL(join(output,'sinkCap.ts')).href);
const sourceDb = new Database(process.env.PROFILE_DB ?? '/srv/DitzyTavern/data/ditzytavern.sqlite', { readonly: true });
await Bun.write(join(output,'production.sqlite'), sourceDb.serialize());
sourceDb.close();
await Bun.write(join(output,'clients-entry.mjs'), [
  ['requestEmbeddings','src/server/model-client/embeddings.ts'],
  ['discoverModels','src/server/model-client/discovery.ts'],
  ['requestDecisions','src/server/decision-model/index.ts'],
].map(([name,file]) => `export { ${name} } from ${JSON.stringify(join(repo,file))};`).join('\n'));
const readers = { baseline, candidate, sink64k, sinkCap };
const clients = {};
for (const side of Object.keys(readers)) {
  const result = await Bun.build({
    entrypoints: [new URL('./clients-entry.mjs', artifactUrl).pathname],
    target: 'bun',
    plugins: [{name:'reader-variant', setup(build) {
      build.onLoad({filter: /\/model-fetch\.ts$/}, async () => ({contents: await Bun.file(new URL(`./${side}.ts`, artifactUrl)).text(), loader:'ts'}));
    }}],
  });
  assert.equal(result.success, true, result.logs.join('\n'));
  const filename = new URL(`./clients-${side}.mjs`, artifactUrl);
  await Bun.write(filename,result.outputs[0]);
  clients[side] = await import(filename.href);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const signal = new AbortController().signal;
const samples = [];
let operations = 0;
let bytesChecked = 0;
let serverRequests = 0;

function chunksOf(bytes, size) {
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
}

function responseOf(chunks) {
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index < chunks.length) controller.enqueue(chunks[index++]);
    else controller.close();
  }}));
}

function verify(bytes, expected, truncated, expectedTruncated) {
  assert.equal(truncated, expectedTruncated);
  assert.equal(bytes.length, expected.length);
  for (const index of [0, Math.floor(bytes.length / 2), bytes.length - 1]) assert.equal(bytes[index], expected[index]);
  bytesChecked += bytes.length;
  operations++;
}

async function correctness() {
  let checks = 0;
  for (const read of Object.values(readers)) {
    for (const [size, chunkSize, cap] of [[0,1,0], [1,1,0], [3,1,3], [7,3,5], [7,3,7], [7,3,9], [100001,13,65536]]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
      const response = responseOf(chunksOf(bytes, chunkSize));
      const result = await read(response, cap, signal);
      assert.deepEqual(result.bytes, bytes.subarray(0, cap));
      assert.equal(result.truncated, size > cap);
      assert.equal(response.body.locked, false);
      checks++;
    }
    assert.deepEqual(await read(new Response(null), 10, signal), { bytes: new Uint8Array(), truncated: false });
    checks++;
    let canceled = 0;
    const overCap = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1,2,3,4])); },
      cancel() { canceled++; return Promise.reject(new Error('cancel rejection')); },
    }));
    assert.deepEqual(await read(overCap, 2, signal), { bytes: new Uint8Array([1,2]), truncated: true });
    assert.equal(canceled, 1);
    assert.equal(overCap.body.locked, false);
    checks++;
    const reason = new Error('caller abort');
    const before = new AbortController();
    before.abort(reason);
    await assert.rejects(read(responseOf([]), 10, before.signal), error => error === reason);
    checks++;
    const during = new AbortController();
    const pending = new Response(new ReadableStream({ cancel(value) { assert.equal(value, reason); canceled++; } }));
    let consuming;
    const started = new Promise(resolve => { consuming = resolve; });
    const result = fetchWithTimeout(async () => pending, 'http://unused.test', { signal: during.signal }, 1000, (response, signal) => {
      consuming();
      return read(response, 10, signal);
    });
    await started;
    during.abort(reason);
    await assert.rejects(result, error => error === reason);
    assert.equal(pending.body.locked, false);
    assert.equal(canceled, 2);
    checks++;
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(reason); } }));
    await assert.rejects(read(broken, 10, signal), error => error === reason);
    assert.equal(broken.body.locked, false);
    checks++;
  }
  console.log(JSON.stringify({ correctnessChecks: checks }));
}

import { Database } from 'bun:sqlite';
const db = new Database(new URL('./production.sqlite', artifactUrl).pathname, { readonly: true });
const productionPayloads = [];
const groups = db.query('SELECT profile_id, count(*) AS models FROM connection_profile_discovery_model GROUP BY profile_id').all();
for (const group of groups) {
  const data = db.query('SELECT model_id AS id FROM connection_profile_discovery_model WHERE profile_id = ? ORDER BY model_id').all(group.profile_id);
  productionPayloads.push({ name: `catalog-${data.length}models`, kind: 'catalog', bytes: encoder.encode(JSON.stringify({data})), cap: 2*1024*1024, count: data.length });
}
for (const [dimensions, count] of [[1024,1], [3072,1], [3072,16], [3072,64]]) {
  const rows = db.query('SELECT vector FROM embedding_cache WHERE length(vector) = ? ORDER BY text_hash LIMIT ?').all(dimensions*4, count);
  const data = rows.map(({vector},index) => ({index, embedding: Array.from(new Float32Array(vector.buffer, vector.byteOffset, vector.byteLength/4))}));
  productionPayloads.push({ name: `embeddings-${count}x${dimensions}`, kind: 'embeddings', bytes: encoder.encode(JSON.stringify({data})), cap: 16*1024*1024, count, dimensions });
}
const traces = db.query('SELECT value FROM message_variant_data WHERE namespace = ? AND key = ?')
  .all('generation-box','traces')
  .map(({value}) => JSON.parse(value)['box:memory']?.trace)
  .filter(Boolean)
  .sort((a,b) => a.candidates.length-b.candidates.length);
for (const [size, trace] of [['median',traces[Math.floor(traces.length/2)]], ['max',traces.at(-1)]]) {
  const answers = Object.fromEntries(trace.candidates.map((candidate,index) => [`relevance_${index}`, { type: 'score', score: candidate.relevanceScore, probabilities: {} }]));
  productionPayloads.push({name: `decision-${size}-${trace.candidates.length}answers`, kind:'decision', bytes:encoder.encode(JSON.stringify({answers})), cap:256*1024, count:trace.candidates.length});
}
db.close();
console.log(JSON.stringify({productionPayloads: productionPayloads.map(({bytes,...rest}) => ({...rest, size:bytes.length}))}));
const cases = productionPayloads.map(item => ({ ...item, size:item.bytes.length, chunk:16*1024 }));

async function measure(name, mode, run, maxIterations = 100000) {
  const sideNames = Object.keys(readers);
  const pilots = [];
  for (const side of sideNames) {
    const start = performance.now();
    let count = 0;
    do { await run(side); count++; } while (performance.now() - start < 50 && count < maxIterations);
    pilots.push(count / (performance.now() - start));
  }
  const iterations = Math.max(3, Math.min(maxIterations, Math.floor(Math.min(...pilots) * 120)));
  const results = Object.fromEntries(sideNames.map(side => [side, []]));
  for (let sample = 0; sample < 7; sample++) {
    for (const side of sample % 2 ? [...sideNames].reverse() : sideNames) {
      Bun.gc(true);
      const start = performance.now();
      for (let i = 0; i < iterations; i++) await run(side);
      results[side].push((performance.now() - start) * 1000 / iterations);
    }
  }
  const summarize = values => {
    const sorted = [...values].sort((a,b) => a-b);
    return { medianUs: sorted[3], minUs: sorted[0], maxUs: sorted[6], samplesUs: values };
  };
  const row = { name, mode, iterations, ...Object.fromEntries(sideNames.map(side => [side, summarize(results[side])])) };
  row.changePercent = (row.candidate.medianUs / row.baseline.medianUs - 1) * 100;
  samples.push(row);
  console.log(JSON.stringify(row));
}

await correctness();
const profileSide = process.env.PROFILE_SIDE;
if (profileSide) assert.ok(Object.hasOwn(readers, profileSide));
for (const item of cases) {
  const bytes = item.bytes;
  const chunks = chunksOf(bytes, item.chunk);
  const expected = bytes.subarray(0, item.cap);
  const runReader = async side => {
    const value = await readers[side](responseOf(chunks), item.cap, signal);
    verify(value.bytes, expected, value.truncated, item.size > item.cap);
  };
  if (!profileSide) await measure(item.name, 'reader', runReader);
}

const payloads = Object.fromEntries(productionPayloads.map(item => [item.name,item.bytes]));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  serverRequests++;
  const url = new URL(request.url);
  if (url.searchParams.has('delay')) await Bun.sleep(20);
  return new Response(payloads[url.pathname.slice(1)], { headers: { 'content-type': 'application/json' } });
}});
try {
  for (const [name, concurrency, delay] of [
    ...productionPayloads.map(item => [item.name,1,false]),
    ['embeddings-64x3072',8,false],
    ['catalog-33models',1,true],
  ]) {
    const item = productionPayloads.find(item => item.name === name);
    const url = `http://127.0.0.1:${server.port}/${name}${delay ? '?delay' : ''}`;
    const input = Array.from({length:item.count}, () => 'sample');
    const questions = Object.fromEntries(Array.from({length:item.count}, (_,index) => [`relevance_${index}`,{type:'score'}]));
    const expected = JSON.parse(decoder.decode(item.bytes));
    const checkResponse = async (input, init) => { const response = await fetch(input,init); assert.equal(response.status,200); return response; };
    const one = async (side, verifyAll = false) => {
      let value;
      if (item.kind === 'embeddings') {
        value = await clients[side].requestEmbeddings(input, {endpoint:url,model:'benchmark',secrets:null,timeoutMs:10000,fetch:checkResponse});
        assert.equal(value.length,item.count);
        assert.equal(value.at(-1).length,item.dimensions);
        assert.equal(value.at(-1).at(-1),expected.data.at(-1).embedding.at(-1));
        if (verifyAll) for (let i=0;i<value.length;i++) assert.deepEqual(value[i],expected.data[i].embedding);
      } else if (item.kind === 'catalog') {
        value = await clients[side].discoverModels({profile:{
          displayName:'benchmark',apiFormat:'chat-completions',requestUrl:url,modelsUrl:url,
          modelBackend:'automatic',adapter:'openai-compatible',outputTokenRepresentation:'automatic',timeoutMs:10000,pinnedModels:[],
        }}, {fetch:checkResponse});
        assert.equal(value.outcome,'success');
        assert.equal(value.catalog.length,item.count);
        if (verifyAll) assert.deepEqual([...value.catalog].sort(),expected.data.map(row=>row.id).sort());
      } else {
        value = await clients[side].requestDecisions({request:JSON.stringify({questions}),questions,selection:{
          endpoint:url,model:'benchmark',profileName:'benchmark',stateTokenLimit:16000,credential:null,headers:{},timeoutMs:10000,
        },fetch:checkResponse});
        assert.equal(value.size,item.count);
        if (verifyAll) assert.deepEqual(Object.fromEntries(value),expected.answers);
      }
      operations++;
      bytesChecked += item.bytes.length;
    };
    for (const side of Object.keys(readers)) await one(side,true);
    const run = side => Promise.all(Array.from({ length: concurrency }, () => one(side)));
    if (profileSide) {
      if (name === 'embeddings-16x3072' && concurrency === 1 && !delay) {
        const until = performance.now() + 3000;
        while (performance.now() < until) await run(profileSide);
      }
    } else await measure(`${name}-${payloads[name].length}B-c${concurrency}${delay ? '-delay20ms' : ''}`, 'actual-client+http', run, delay ? 10 : 10000);
  }
} finally { await server.stop(true); }
console.log(JSON.stringify({ operations, bytesChecked, serverRequests, failures: 0 }));
if (!profileSide) await Bun.write(new URL('./production-results.json', artifactUrl), JSON.stringify({ runtime: Bun.version, samples, operations, bytesChecked, serverRequests, failures: 0 }, null, 2));
