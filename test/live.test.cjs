// Live run of the compiled Rendley node against the tunnelled local API.
const path = require('node:path');
const assert = require('node:assert');
const DIST = require('node:path').join(__dirname, '..', 'dist');
const { Rendley } = require(path.join(DIST, 'nodes/Rendley/Rendley.node.js'));
const KEY = process.env.RENDLEY_API_KEY; const BASE = process.env.RENDLEY_API_BASE_URL || 'https://api.rendley.com/v1';
if (!KEY) { console.error('Set RENDLEY_API_KEY (a paid-plan key; the run spends a few credits).'); process.exit(1); }
const log = [];
function httpErrorFrom(status, bodyText) { let parsed; try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; } const e = new Error((parsed && parsed.error && parsed.error.message) || `status ${status}`); e.httpCode = String(status); e.response = { status, body: parsed }; return e; }
async function doRequest(options, auth) {
  const url = (options.baseURL || '') + options.url; const headers = { ...(options.headers || {}) }; if (auth) headers.authorization = auth;
  let body; if (options.body !== undefined) { if (Buffer.isBuffer(options.body)) body = options.body; else { body = JSON.stringify(options.body); headers['content-type'] = 'application/json'; } }
  const t = Date.now(); const r = await fetch(url, { method: options.method, headers, body }); const buf = Buffer.from(await r.arrayBuffer());
  log.push({ m: options.method, url: url.replace(/\?.*/, ''), status: r.status, ms: Date.now() - t });
  if (r.status >= 400) throw httpErrorFrom(r.status, buf.toString());
  if (options.returnFullResponse) return { body: buf, headers: Object.fromEntries(r.headers), statusCode: r.status };
  if (options.encoding === 'arraybuffer') return buf; if (options.json === false) return buf.toString();
  const text = buf.toString(); try { return JSON.parse(text); } catch { return text; }
}
function makeCtx(params, items = [{ json: {} }], opts = {}) {
  const creds = { apiKey: KEY, apiBaseUrl: BASE };
  return { getInputData: () => items, getNode: () => ({ name: 'Rendley', type: 'n8n-nodes-rendley.rendley' }), continueOnFail: () => false, getCredentials: async () => creds,
    getNodeParameter: (name, i, def, o) => { let v = name in params ? params[name] : def; if (v && typeof v === 'object' && 'mode' in v && o && o.extractValue) v = v.value; return v; },
    getCurrentNodeParameter: (name) => params[name],
    helpers: { httpRequestWithAuthentication: async (_c, options) => doRequest(options, `Bearer ${creds.apiKey}`), httpRequest: async (options) => doRequest(options), getBinaryDataBuffer: async (i, prop) => items[i].binary[prop].buf } };
}
const node = new Rendley();
const run = (params, items, opts) => node.execute.call(makeCtx(params, items, opts));
const base = { pollInterval: 5, pollTimeout: 10 };
const results = []; const ok = (name, extra = '') => { results.push(`PASS ${name} ${extra}`); console.log(`PASS ${name} ${extra}`); };
const fail = (name, e) => { results.push(`FAIL ${name}: ${e && e.message || e}`); console.log(`FAIL ${name}: ${e && e.message || e}`); };
const step = async (name, fn) => { try { const r = await fn(); ok(name, r || ''); return r; } catch (e) { fail(name, e); } };
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let projectId;
(async () => {
  const lo = makeCtx({ resource: 'video', operation: 'generate' });
  await step('loadOptions.getWorkspacesOrDefault', async () => { const o = await node.methods.loadOptions.getWorkspacesOrDefault.call(lo); assert.ok(o.length >= 2); return `${o.length - 1} workspace(s)`; });
  await step('loadOptions.getVoices', async () => { const o = await node.methods.loadOptions.getVoices.call(lo); assert.ok(o.length > 0); return `${o.length} voices, first "${o[0].name}"`; });
  await step('loadOptions.getTranslateLanguages', async () => { const o = await node.methods.loadOptions.getTranslateLanguages.call(lo); assert.ok(o.length > 0); return `${o.length} languages`; });
  await step('loadOptions.getModels video:generate', async () => { const o = await node.methods.loadOptions.getModels.call(lo); assert.ok(o.length > 1); return o.map((x) => x.value || 'Default').join(', '); });
  await step('loadOptions.getModels audio:textToSpeech', async () => { const o = await node.methods.loadOptions.getModels.call(makeCtx({ resource: 'audio', operation: 'textToSpeech' })); return o.map((x) => x.value || 'Default').join(', '); });
  await step('loadOptions.getModels video:dub', async () => { const o = await node.methods.loadOptions.getModels.call(makeCtx({ resource: 'video', operation: 'dub' })); return o.map((x) => x.value || 'Default').join(', '); });

  await step('project:create', async () => { const out = await run({ resource: 'project', operation: 'create', name: 'n8n-live-test', workspaceId: '', templateId: '' }); projectId = out[0][0].json.id; assert.ok(projectId); return projectId; });
  await step('project:get (simplified)', async () => { const out = await run({ resource: 'project', operation: 'get', projectId: { mode: 'id', value: projectId }, simplify: true }); assert.strictEqual(out[0][0].json.name, 'n8n-live-test'); assert.strictEqual(out[0][0].json.project_json, undefined); return `keys: ${Object.keys(out[0][0].json).join(',')}`; });
  await step('project:list contains it', async () => { const out = await run({ resource: 'project', operation: 'list', workspaceId: '' }); assert.ok(out[0].some((i) => i.json.id === projectId)); return `${out[0].length} projects`; });
  await step('listSearch.searchProjects', async () => { const r = await node.methods.listSearch.searchProjects.call(lo, 'n8n-live'); assert.ok(r.results.some((x) => x.value === projectId)); });

  let pngUpload, mp3Upload;
  await step('media:upload binary png', async () => { const out = await run({ resource: 'media', operation: 'upload', projectId: { mode: 'id', value: projectId }, uploadSource: 'binary', binaryPropertyName: 'data', uploadFileName: 'dot.png' }, [{ json: {}, binary: { data: { buf: PNG, mimeType: 'image/png', fileName: 'dot.png' } } }]); pngUpload = out[0][0].json; assert.ok(pngUpload.file_hash); return `media_id=${pngUpload.media_id} hash=${pngUpload.file_hash}`; });
  await step('media:upload url mp3 (3s sample)', async () => { const out = await run({ resource: 'media', operation: 'upload', projectId: { mode: 'id', value: projectId }, uploadSource: 'url', uploadUrl: 'https://download.samplelib.com/mp3/sample-3s.mp3', uploadFileName: '' }); mp3Upload = out[0][0].json; assert.ok(mp3Upload.media_id); return `name=${mp3Upload.file_name} mime=${mp3Upload.mime_type} status=${mp3Upload.status} media_id=${mp3Upload.media_id} hash=${mp3Upload.file_hash}`; });
  await step('media:list', async () => { const out = await run({ resource: 'media', operation: 'list', projectId: { mode: 'id', value: projectId } }); assert.ok(out[0].length >= 2); assert.ok(out[0].every((i) => i.json.url)); return `${out[0].length} uploads, statuses: ${out[0].map((i) => i.json.status).join(',')}`; });
  await step('media:getDownloadUrl by hash + fetch', async () => { const out = await run({ resource: 'media', operation: 'getDownloadUrl', projectId: { mode: 'id', value: projectId }, mediaId: '', fileHash: pngUpload.file_hash }); const url = out[0][0].json.url; const r = await fetch(url); assert.strictEqual(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); assert.strictEqual(b.length, PNG.length); return `via=${out[0][0].json.resolved_via}, downloaded ${b.length} bytes`; });
  await step('media:getDownloadUrl by media_id', async () => { const out = await run({ resource: 'media', operation: 'getDownloadUrl', projectId: { mode: 'id', value: projectId }, mediaId: pngUpload.media_id, fileHash: '' }); assert.ok(out[0][0].json.url); return `via=${out[0][0].json.resolved_via}`; });

  await step('estimateCostOnly video:generate', async () => { const out = await run({ ...base, resource: 'video', operation: 'generate', projectId: { mode: 'id', value: projectId }, modelId: '', aiPrompt: 'a cat', aiOptions: { duration: 5 }, extraParams: '', estimateCostOnly: true }); assert.strictEqual(typeof out[0][0].json.credits, 'number'); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly audio:generateSoundEffect', async () => { const out = await run({ ...base, resource: 'audio', operation: 'generateSoundEffect', projectId: { mode: 'id', value: projectId }, modelId: '', aiPrompt: 'rain', aiOptions: { duration_seconds: 2 }, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly video:transcribe (hash)', async () => { const out = await run({ ...base, resource: 'video', operation: 'transcribe', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: mp3Upload.file_hash, aiOptions: {}, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly video:isolateVoice (media_id)', async () => { const out = await run({ ...base, resource: 'video', operation: 'isolateVoice', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: mp3Upload.media_id, aiOptions: {}, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly video:isolateVoice (URL, no duration)', async () => { const out = await run({ ...base, resource: 'video', operation: 'isolateVoice', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: 'https://download.samplelib.com/mp3/sample-3s.mp3', aiOptions: {}, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly video:lipSync (URL video + hash audio)', async () => { const out = await run({ ...base, resource: 'video', operation: 'lipSync', projectId: { mode: 'id', value: projectId }, modelId: '', videoFile: 'https://download.samplelib.com/mp4/sample-5s.mp4', audioFile: mp3Upload.file_hash, aiOptions: {}, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly image:upscale (URL)', async () => { const out = await run({ ...base, resource: 'image', operation: 'upscale', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: 'https://download.samplelib.com/png/sample-red-400x300.png', aiOptions: { scale: 2 }, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly video:upscale (URL)', async () => { const out = await run({ ...base, resource: 'video', operation: 'upscale', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: 'https://download.samplelib.com/mp4/sample-5s.mp4', aiOptions: {}, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('estimateCostOnly video:changeVoice (hash)', async () => { const voices = await node.methods.loadOptions.getVoices.call(lo); const out = await run({ ...base, resource: 'video', operation: 'changeVoice', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: mp3Upload.file_hash, voiceId: voices[0].value, aiOptions: {}, extraParams: '', estimateCostOnly: true }); return `credits=${out[0][0].json.credits}`; });
  await step('export:estimateCost', async () => { const out = await run({ resource: 'export', operation: 'estimateCost', projectId: { mode: 'id', value: projectId }, settings: { target_resolution: '720p' } }); return `credits=${out[0][0].json.credits}`; });
  await step('brandKit:get', async () => { const out = await run({ resource: 'brandKit', operation: 'get', brandKitWorkspaceId: (await node.methods.loadOptions.getWorkspaces.call(lo))[0].value }); assert.ok(out[0][0].json.id); return `keys: ${Object.keys(out[0][0].json).slice(0, 8).join(',')}`; });

  // paid, cheap
  await step('audio:generateSoundEffect 2s WAIT', async () => { const t = Date.now(); const out = await run({ ...base, resource: 'audio', operation: 'generateSoundEffect', projectId: { mode: 'id', value: projectId }, modelId: '', aiPrompt: 'a single soft rain drop', aiOptions: { duration_seconds: 2 }, extraParams: '', estimateCostOnly: false, additionalOptions: {}, waitForCompletion: true }); const j = out[0][0].json; assert.strictEqual(j.status, 'completed'); assert.ok(j.url, 'url'); const r = await fetch(j.url); assert.strictEqual(r.status, 200); return `${Math.round((Date.now() - t) / 1000)}s, job=${j.job_id}, expires=${j.url_expires_at}, via=${j.upload && j.upload.resolved_via ? j.upload.resolved_via : 'job.output'}, fetched ${r.headers.get('content-type')}`; });
  await step('video:transcribe mp3 hash WAIT', async () => { const t = Date.now(); const out = await run({ ...base, resource: 'video', operation: 'transcribe', projectId: { mode: 'id', value: projectId }, modelId: '', mediaFile: mp3Upload.file_hash, aiOptions: {}, extraParams: '', estimateCostOnly: false, additionalOptions: {}, waitForCompletion: true }); const j = out[0][0].json; assert.strictEqual(j.status, 'completed'); let peek = ''; if (j.url) { const r = await fetch(j.url); peek = ` fetched ${r.status} ${r.headers.get('content-type')}`; } return `${Math.round((Date.now() - t) / 1000)}s, result keys: ${Object.keys(j.result_data || {}).join(',')}, url=${j.url ? 'yes' : 'NO'}${peek}`; });

  // agent, same host
  let agentJob;
  await step('agent:run WAIT (trivial prompt)', async () => { const t = Date.now(); const out = await run({ ...base, resource: 'agent', operation: 'run', prompt: 'Reply with the single word OK and make no changes.', projectId: { mode: 'id', value: projectId }, files: {}, additionalOptions: {}, waitForCompletion: true, renderAfter: false }); agentJob = out[0][0].json; assert.ok(agentJob.job_id); assert.strictEqual(agentJob.status, 'completed'); return `${Math.round((Date.now() - t) / 1000)}s ${JSON.stringify({ ...agentJob, last_message: (agentJob.last_message || '').slice(0, 60) })}`; });
  await step('agent:getJob via node', async () => { const out = await run({ resource: 'agent', operation: 'getJob', agentJobId: agentJob.job_id }); assert.strictEqual(out[0][0].json.job_id, agentJob.job_id); return `status=${out[0][0].json.status} keys=${Object.keys(out[0][0].json).join(',')}`; });
  await step('agent:run WAIT with a 3 s timeout stops waiting and names the job, which Get Job then reads', async () => { let err; let jobId; try { await run({ ...base, pollTimeout: 0.05, pollInterval: 5, resource: 'agent', operation: 'run', prompt: 'Add a short title card that says Long job test, then stop.', projectId: { mode: 'id', value: projectId }, files: {}, additionalOptions: {}, waitForCompletion: true, renderAfter: false }); } catch (e) { err = e; } assert.ok(err, 'expected the wait to stop'); assert.match(err.message, /still .* after .* minutes/); jobId = (err.message.match(/"([0-9a-f-]{36})"/) || [])[1]; assert.ok(jobId, 'job id in the message'); assert.match(err.description || '', /Get Job/); const out = await run({ resource: 'agent', operation: 'getJob', agentJobId: jobId }); assert.strictEqual(out[0][0].json.job_id, jobId); await run({ resource: 'agent', operation: 'cancelJob', agentJobId: jobId }).catch(() => {}); return `job=${jobId} status_after=${out[0][0].json.status}`; });
  await step('agent:run (no wait) then cancelJob', async () => { const out = await run({ ...base, resource: 'agent', operation: 'run', prompt: 'Reply with the single word OK and make no changes.', projectId: { mode: 'id', value: projectId }, files: {}, additionalOptions: {}, waitForCompletion: false, renderAfter: false }); const j = out[0][0].json; assert.ok(j.job_id); const c = await run({ resource: 'agent', operation: 'cancelJob', agentJobId: j.job_id }); return `started status=${j.status}; cancel -> status=${c[0][0].json.status} reason=${c[0][0].json.reason}`; });

  await step('project:delete returns {deleted:true}', async () => { const p = await run({ resource: 'project', operation: 'create', name: 'n8n-live-test-del', workspaceId: '', templateId: '' }); const out = await run({ resource: 'project', operation: 'delete', projectId: { mode: 'id', value: p[0][0].json.id } }); assert.deepStrictEqual(out[0][0].json, { deleted: true, id: p[0][0].json.id }); });

  await step('project:delete (cleanup)', async () => { const out = await run({ resource: 'project', operation: 'delete', projectId: { mode: 'id', value: projectId } }); assert.strictEqual(out[0][0].json.deleted, true); });
  console.log('\n--- request log ---'); for (const l of log) console.log(`${l.m} ${l.url.replace(BASE, '')} -> ${l.status} (${l.ms}ms)`);
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} pass / ${results.filter((r) => r.startsWith('FAIL')).length} fail`);
})().catch((e) => { console.error('ABORT', e); });
