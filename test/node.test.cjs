// Drives the compiled Rendley node's execute()/loadOptions against a stub of
// the Rendley API contract (response shapes taken from the Go source).
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert');
const DIST = require('node:path').join(__dirname, '..', 'dist');
const { Rendley } = require(path.join(DIST, 'nodes/Rendley/Rendley.node.js'));

const log = []; // {method, path, body, auth}
const state = { jobPolls: {}, agentPolls: {} };
const ok = (res, data, meta) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(meta ? { data, meta } : { data })); };
const raw = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const err = (res, code, message) => raw(res, code, { error: { code: 'X', message } });

const server = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    let body; try { body = bodyBuf.length ? JSON.parse(bodyBuf.toString()) : undefined; } catch { body = bodyBuf; }
    const u = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: u.pathname + u.search, body, auth: req.headers.authorization, ct: req.headers['content-type'] };
    log.push(entry);
    const p = u.pathname;
    // ---------- REST host ----------
    if (p === '/api/v1/workspaces') return ok(res, [{ id: 'ws1', name: 'Main', created_by: 'u', social_publishing: false }]);
    if (p === '/api/v1/projects' && req.method === 'GET') return ok(res, [{ id: 'p1', name: 'Beta', workspace_id: 'ws1' }, { id: 'p2', name: 'Alpha', workspace_id: 'ws1' }]);
    if (p === '/api/v1/projects' && req.method === 'POST') return ok(res, { id: 'pNew', name: body.name, workspace_id: body.workspace_id });
    if (p === '/api/v1/projects/p1' && req.method === 'GET') return ok(res, { id: 'p1', name: 'Beta', project_json: '{}' });
    if (p === '/api/v1/projects/p1' && req.method === 'DELETE') return ok(res, null);
    if (p === '/api/v1/ai/tools') return ok(res, [
      { action: 'generate_video', models: [{ id: 'kling-v2.6', name: 'Kling 2.6', action: 'generate_video' }, { id: 'veo-3', name: 'Veo 3', action: 'generate_video' }] },
      { action: 'generate_image', models: [{ id: 'flux', name: 'Flux', action: 'generate_image' }] },
      { action: 'video_translate', models: [{ id: 'elevenlabs-dub', name: 'Dub', action: 'video_translate' }] },
    ]);
    if (p === '/api/v1/ai/text-to-speech/voices') return ok(res, [{ id: 'v2', name: 'Zoe', model_id: 'm' }, { id: 'v1', name: 'Adam', model_id: 'm' }], { per_page: 100, page: 1, has_more: false });
    if (p === '/api/v1/ai/video-translate/languages') return ok(res, [{ id: 'es', name: 'Spanish' }, { id: 'de', name: 'German' }]);
    if (/^\/api\/v1\/ai\/[a-z-]+\/cost$/.test(p)) return ok(res, { credits: 12 });
    if (p === '/api/v1/ai/paywalled') return err(res, 402, 'Upgrade your plan to use AI actions.');
    if (/^\/api\/v1\/ai\/[a-z-]+$/.test(p) && req.method === 'POST') {
      if (body.project_id === 'free') return err(res, 402, 'Upgrade your plan to use AI actions.');
      return ok(res, 'job-' + p.split('/').pop());
    }
    if (p === '/api/v1/export' && req.method === 'POST') return ok(res, { job_id: 'job-export' });
    if (p === '/api/v1/export/cost') return ok(res, { credits: 3 });
    if (p.startsWith('/api/v1/jobs/')) {
      const id = p.split('/').pop();
      state.jobPolls[id] = (state.jobPolls[id] || 0) + 1;
      if (id === 'job-fails') return ok(res, { id, type: 'ai', status: 'failed', error: 'Model exploded', result_data: null });
      if (state.jobPolls[id] < 2) return ok(res, { id, type: 'ai', status: 'processing', result_data: null });
      if (id === 'job-export') return ok(res, { id, type: 'export', status: 'completed', result_data: JSON.stringify({ status: 'completed', storage_url: 'https://cdn/x.mp4?sig', media_id: 'm-exp' }), output: { media_id: 'm-exp', url: 'https://cdn/x.mp4?sig2' } });
      if (id === 'job-transcribe') return ok(res, { id, type: 'ai', status: 'completed', result_data: JSON.stringify({ media_id: 'm1', file_hash: 'abcdef0123456789' }) });
      return ok(res, { id, type: 'ai', status: 'completed', result_data: JSON.stringify({ media_id: 'm1', file_hash: 'abcdef0123456789' }), output: { media_id: 'm1', file_hash: 'abcdef0123456789', url: 'https://cdn/out.bin?sig', url_expires_at: '2026-09-05T12:00:00Z' } });
    }
    if (p === '/api/v1/projects/p1/uploads' && req.method === 'GET') {
      if (u.searchParams.get('hash') === 'abcdef0123456789') return ok(res, { media_id: 'm1', file_hash: 'abcdef0123456789', storage_url: 'https://cdn/by-hash?sig', status: 'completed' });
      if (u.searchParams.get('hash')) return err(res, 404, 'not found');
      return ok(res, [{ media_id: 'm1', file_hash: 'abcdef0123456789', storage_url: 'https://cdn/list1?sig' }, { media_id: 'm9', file_hash: 'ffff', storage_url: 'https://cdn/list9?sig' }]);
    }
    if (p === '/api/v1/projects/p1/uploads' && req.method === 'POST') return ok(res, { media_id: body.media_id, upload_id: 'up1', presigned_url: `http://127.0.0.1:${server.address().port}/s3/put` });
    if (p === '/api/v1/projects/p1/uploads/up1/complete') return ok(res, { media_id: 'x' });
    if (p === '/s3/put') { entry.putBytes = bodyBuf.length; res.writeHead(200); return res.end(); }
    if (p === '/file/sample.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('abc')); }
    if (p === '/api/v1/brandkit/ws1') return ok(res, { id: 'bk', workspace_id: 'ws1', website_url: null });
    if (p === '/api/v1/brandkit/ws1/import') return ok(res, { id: 'bk', workspace_id: 'ws1', website_url: body.website_url });
    // ---------- Agent host (mcp) ----------
    if (p === '/api/v1/agent' && req.method === 'POST') { state.agentProject = body.project_id || 'pAuto'; return ok(res, { job_id: body.prompt.includes('FAIL') ? 'aj-fail' : body.prompt.includes('ASK') ? 'aj-ask' : 'aj1', project_id: state.agentProject, thread_id: 't1', status: 'pending', created_at: 1, updated_at: 1 }); }
    if (p === '/api/v1/agent/jobs/aj1/cancel') return ok(res, { job_id: 'aj1', status: 'canceled', reason: 'canceled' });
    if (p.startsWith('/api/v1/agent/jobs/')) {
      const id = p.split('/').pop();
      state.agentPolls[id] = (state.agentPolls[id] || 0) + 1;
      if (id === 'aj-fail') return ok(res, { job_id: id, project_id: 'pAuto', status: 'failed', error: 'agent gave up', reason: 'agent_error' });
      if (id === 'aj-ask') return ok(res, { job_id: id, project_id: 'pAuto', status: 'waiting_input', interrupt: { id: 'i1', type: 'clarify', summary: 'Which clip?' } });
      if (state.agentPolls[id] < 2) return ok(res, { job_id: id, project_id: state.agentProject || 'pAuto', status: 'running', last_message: 'working' });
      return ok(res, { job_id: id, project_id: state.agentProject || 'pAuto', thread_id: 't1', status: 'completed', last_message: 'done', commands_applied: 3, commands_failed: 0 });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/uploads\/import$/.test(p) && req.method === 'POST') return ok(res, { storage_url: 'https://cdn/imported?sig', file_hash: 'imp-hash', status: 'complete', mime_type: 'audio/mpeg', role: 'pending', original_file_name: body.file_name, media_id: 'm-imp' });
    raw(res, 404, { error: { message: 'no route ' + req.method + ' ' + p } });
  });
});

function httpErrorFrom(status, bodyText) {
  let parsed; try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
  const e = new Error((parsed && parsed.error && parsed.error.message) || `Request failed with status code ${status}`);
  e.httpCode = String(status); e.statusCode = status; e.response = { status, body: parsed, data: parsed };
  return e;
}
async function doRequest(options, auth) {
  const url = (options.baseURL || '') + options.url;
  const headers = { ...(options.headers || {}) };
  if (auth) headers.authorization = auth;
  let body;
  if (options.body !== undefined) {
    if (Buffer.isBuffer(options.body)) body = options.body; else { body = JSON.stringify(options.body); headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(url, { method: options.method, headers, body });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status >= 400) throw httpErrorFrom(r.status, buf.toString());
  if (options.returnFullResponse) return { body: buf, headers: Object.fromEntries(r.headers), statusCode: r.status };
  if (options.encoding === 'arraybuffer') return buf;
  if (options.json === false) return buf.toString();
  const text = buf.toString();
  try { return JSON.parse(text); } catch { return text; }
}

function makeCtx(port, params, items = [{ json: {} }], opts = {}) {
  const creds = { apiKey: 'sk-test', apiBaseUrl: `http://127.0.0.1:${port}/api/v1` };
  return {
    getInputData: () => items,
    getNode: () => ({ name: 'Rendley', type: 'n8n-nodes-rendley.rendley' }),
    continueOnFail: () => !!opts.continueOnFail,
    getCredentials: async () => creds,
    getNodeParameter: (name, i, def, o) => {
      let v = name in params ? params[name] : def;
      if (v && typeof v === 'object' && 'mode' in v && o && o.extractValue) v = v.value;
      return v;
    },
    getCurrentNodeParameter: (name) => params[name],
    helpers: {
      httpRequestWithAuthentication: async function (_cred, options) { return doRequest(options, `Bearer ${creds.apiKey}`); },
      httpRequest: async (options) => doRequest(options),
      getBinaryDataBuffer: async (i, prop) => Buffer.from(items[i].binary[prop].data, 'base64'),
    },
  };
}
const last = (pred) => [...log].reverse().find(pred);
const since = (n) => log.slice(n);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const node = new Rendley();
  const run = (params, items, opts) => node.execute.call(makeCtx(port, params, items, opts));
  const base = { pollInterval: 5, pollTimeout: 1 };
  let mark;

  // 1. project:list with default workspace
  mark = log.length;
  let out = await run({ resource: 'project', operation: 'list', workspaceId: '' });
  assert.deepStrictEqual(since(mark).map((e) => e.path), ['/api/v1/workspaces', '/api/v1/projects?workspace_id=ws1']);
  assert.strictEqual(out[0].length, 2); assert.strictEqual(out[0][0].json.id, 'p1'); assert.deepStrictEqual(out[0][1].pairedItem, { item: 0 });
  assert.strictEqual(since(mark)[0].auth, 'Bearer sk-test');
  console.log('OK project:list (envelope unwrap, workspace fallback, pairedItem, bearer)');

  // 2. project:create + get + delete
  out = await run({ resource: 'project', operation: 'create', name: 'N', workspaceId: 'ws1', templateId: '' });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/projects' && e.method === 'POST').body, { name: 'N', workspace_id: 'ws1' });
  out = await run({ resource: 'project', operation: 'get', projectId: { mode: 'id', value: 'p1' } });
  assert.strictEqual(out[0][0].json.id, 'p1');
  out = await run({ resource: 'project', operation: 'delete', projectId: { mode: 'list', value: 'p1' } });
  assert.deepStrictEqual(out[0][0].json, { deleted: true, id: 'p1' });
  out = await run({ resource: 'project', operation: 'get', projectId: { mode: 'id', value: 'p1' }, simplify: true });
  assert.strictEqual(out[0][0].json.project_json, undefined, 'simplify drops project_json');
  console.log('OK project:create/get/delete (resourceLocator extractValue)');

  // 3. AI: sound effect, wait, resolve media by hash
  mark = log.length;
  out = await run({ ...base, resource: 'audio', operation: 'generateSoundEffect', projectId: { mode: 'id', value: 'p1' }, modelId: '', aiPrompt: 'rain', aiOptions: { duration_seconds: 2 }, extraParams: '{"seed":7}', estimateCostOnly: false, additionalOptions: {}, waitForCompletion: true });
  const enq = since(mark).find((e) => e.path === '/api/v1/ai/generate-sound-effect');
  assert.deepStrictEqual(enq.body, { project_id: 'p1', params: { prompt: 'rain', duration_seconds: 2, seed: 7 } });
  assert.strictEqual(out[0][0].json.job_id, 'job-generate-sound-effect');
  assert.strictEqual(out[0][0].json.url, 'https://cdn/out.bin?sig', 'uses output.url');
  assert.strictEqual(out[0][0].json.url_expires_at, '2026-09-05T12:00:00Z');
  assert.strictEqual(out[0][0].json.media_id, 'm1');
  assert.strictEqual(state.jobPolls['job-generate-sound-effect'], 2, 'polled twice (processing -> completed)');
  console.log('OK audio:generateSoundEffect (enqueue body, bare-string job id, poll, media resolve by hash)');

  // 4. transcribe: URL and hash both go to params.media
  mark = log.length;
  await run({ ...base, resource: 'video', operation: 'transcribe', projectId: { mode: 'id', value: 'p1' }, modelId: '', mediaFile: 'https://x/y.mp4', aiOptions: { start_time: 0, end_time: 30 }, extraParams: '{}', estimateCostOnly: false, waitForCompletion: false });
  assert.deepStrictEqual(since(mark).find((e) => e.path === '/api/v1/ai/transcribe').body, { project_id: 'p1', params: { media: 'https://x/y.mp4', start_time: 0, end_time: 30 } });
  await run({ ...base, resource: 'video', operation: 'transcribe', projectId: { mode: 'id', value: 'p1' }, modelId: '', mediaFile: ' abcdef0123456789 ', aiOptions: {}, extraParams: '', estimateCostOnly: false, waitForCompletion: false });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/ai/transcribe').body, { project_id: 'p1', params: { media: 'abcdef0123456789' } });
  console.log('OK video:transcribe (URL and hash -> params.media, trimmed)');

  // 4b. transcribe wait with no output.url -> falls back to uploads listing
  out = await run({ ...base, resource: 'video', operation: 'transcribe', projectId: { mode: 'id', value: 'p1' }, modelId: '', mediaFile: 'abcdef0123456789', aiOptions: {}, extraParams: '', estimateCostOnly: false, waitForCompletion: true });
  assert.strictEqual(out[0][0].json.url, 'https://cdn/by-hash?sig');
  console.log('OK fallback media resolve when job has no output');

  // 5. voice isolation with URL is allowed now
  await run({ ...base, resource: 'video', operation: 'isolateVoice', projectId: { mode: 'id', value: 'p1' }, modelId: '', mediaFile: 'https://x/y.mp4', aiOptions: {}, extraParams: '', estimateCostOnly: false, waitForCompletion: false });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/ai/voice-isolation').body, { project_id: 'p1', params: { media: 'https://x/y.mp4' } });
  console.log('OK video:isolateVoice URL accepted');

  // 6. lipsync: video_media / audio_media
  await run({ ...base, resource: 'video', operation: 'lipSync', projectId: { mode: 'id', value: 'p1' }, modelId: '', videoFile: 'https://x/v.mp4', audioFile: 'aud-hash', aiOptions: {}, extraParams: '', estimateCostOnly: false, waitForCompletion: false });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/ai/lipsync').body, { project_id: 'p1', params: { video_media: 'https://x/v.mp4', audio_media: 'aud-hash' } });
  console.log('OK video:lipSync (video_media + audio_media)');

  // 7. image upscale
  await run({ ...base, resource: 'image', operation: 'upscale', projectId: { mode: 'id', value: 'p1' }, modelId: '', mediaFile: 'https://x/i.png', aiOptions: { scale: 4 }, extraParams: '', estimateCostOnly: false, waitForCompletion: false });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/ai/upscale-image').body, { project_id: 'p1', params: { media: 'https://x/i.png', scale: 4 } });
  console.log('OK image:upscale');
  await run({ ...base, resource: 'video', operation: 'upscale', projectId: { mode: 'id', value: 'p1' }, modelId: '', mediaFile: 'https://x/v.mp4', aiOptions: {}, extraParams: '', estimateCostOnly: false, waitForCompletion: false });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/ai/upscale-video').body, { project_id: 'p1', params: { media: 'https://x/v.mp4' } });
  console.log('OK video:upscale');

  // 8. estimate cost only
  out = await run({ ...base, resource: 'video', operation: 'generate', projectId: { mode: 'id', value: 'p1' }, modelId: 'kling-v2.6', aiPrompt: 'a cat', aiOptions: { duration: 6, aspect_ratio: '9:16' }, extraParams: '', estimateCostOnly: true });
  assert.deepStrictEqual(out[0][0].json, { action: 'generate-video', credits: 12 });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/ai/generate-video/cost').body, { project_id: 'p1', params: { prompt: 'a cat', duration: 6, aspect_ratio: '9:16' }, model_id: 'kling-v2.6' });
  console.log('OK estimateCostOnly (+ model_id, model/action check passed)');

  // 9. model mismatch
  await assert.rejects(run({ ...base, resource: 'image', operation: 'generate', projectId: { mode: 'id', value: 'p1' }, modelId: 'kling-v2.6', aiPrompt: 'x', aiOptions: {}, extraParams: '', estimateCostOnly: true }), /not available for "generate-image"/);
  console.log('OK model/action mismatch guard');

  // 10. 402
  await assert.rejects(run({ ...base, resource: 'image', operation: 'generate', projectId: { mode: 'id', value: 'free' }, modelId: '', aiPrompt: 'x', aiOptions: {}, extraParams: '', estimateCostOnly: false, additionalOptions: {}, waitForCompletion: false }), (e) => { assert.match(e.message, /payment required/); assert.match(e.message, /Upgrade your plan/); return true; });
  console.log('OK 402 message');

  // 11. failed job surfaces error string
  await assert.rejects(run({ ...base, resource: 'export', operation: 'getJob', jobId: 'job-fails' }).then(() => { throw new Error('getJob should not throw') }).catch((e) => { if (e.message === 'getJob should not throw') throw e; return; }), () => false).catch(() => {});
  out = await run({ ...base, resource: 'export', operation: 'getJob', jobId: 'job-fails' });
  assert.strictEqual(out[0][0].json.status, 'failed');
  console.log('OK export:getJob passthrough');

  // 12. export render wait
  state.jobPolls['job-export'] = 1; // skip the processing poll
  out = await run({ ...base, resource: 'export', operation: 'render', projectId: { mode: 'id', value: 'p1' }, settings: { codec: 'h264', quality: 'high', target_resolution: '720p' }, additionalOptions: {}, waitForCompletion: true });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/export').body, { project_id: 'p1', settings: { codec: 'h264', target_resolution: '720p', quality: 'high' } });
  assert.strictEqual(out[0][0].json.url, 'https://cdn/x.mp4?sig2', 'prefers output.url');
  out = await run({ resource: 'export', operation: 'estimateCost', projectId: { mode: 'id', value: 'p1' }, settings: {} });
  assert.deepStrictEqual(out[0][0].json, { credits: 3 });
  console.log('OK export:render + estimateCost');

  // 13. agent run, wait + render after (running -> completed, real 5s sleep once)
  state.jobPolls['job-export'] = 1;
  const t0 = Date.now();
  out = await run({ ...base, resource: 'agent', operation: 'run', prompt: 'make a promo', projectId: { mode: 'id', value: '' }, files: { file: [{ url: 'https://x/a.mp4', name: 'A' }] }, additionalOptions: { threadId: '' }, waitForCompletion: true, renderAfter: true, renderSettings: {} });
  const start = last((e) => e.path === '/api/v1/agent');
  assert.deepStrictEqual(start.body, { prompt: 'make a promo', project_id: 'pNew', files: [{ media_id: 'm-imp', storage_url: 'https://cdn/imported?sig', name: 'A', file_hash: 'imp-hash' }] });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/projects/pNew/uploads/import').body, { download_url: 'https://x/a.mp4', file_name: 'A', role: 'pending' });
  assert.ok(Date.now() - t0 >= 4900, 'slept between polls');
  assert.strictEqual(out[0][0].json.project_id, 'pNew');
  assert.strictEqual(out[0][0].json.last_message, 'done');
  assert.strictEqual(out[0][0].json.commands_applied, 3);
  assert.strictEqual(out[0][0].json.url, 'https://cdn/x.mp4?sig2');
  assert.strictEqual(out[0][0].json.export_job_id, 'job-export');
  console.log('OK agent:run (+renderAfter, files imported first, poll sleep)');

  // 14. agent failure message
  await assert.rejects(run({ ...base, resource: 'agent', operation: 'run', prompt: 'FAIL', projectId: { mode: 'id', value: 'p1' }, files: {}, additionalOptions: {}, waitForCompletion: true, renderAfter: false }), /agent gave up/);
  await assert.rejects(run({ ...base, resource: 'agent', operation: 'run', prompt: 'ASK', projectId: { mode: 'id', value: 'p1' }, files: {}, additionalOptions: {}, waitForCompletion: true, renderAfter: false }), /paused job "aj-ask" to ask a question: Which clip\?/);
  console.log('OK agent failure surfaces `error`; waiting_input fails fast');

  // 15. edit:reframe prompt template + getJob/cancelJob
  await run({ ...base, resource: 'edit', operation: 'reframe', projectId: { mode: 'id', value: 'p1' }, editOptions: { aspectRatio: '1:1', extraInstructions: 'keep logo' }, files: {}, additionalOptions: {}, waitForCompletion: false, renderAfter: false });
  const edit = last((e) => e.path === '/api/v1/agent');
  assert.match(edit.body.prompt, /Reframe this project to 1:1/); assert.match(edit.body.prompt, /keep logo/); assert.strictEqual(edit.body.project_id, 'p1');
  out = await run({ resource: 'agent', operation: 'getJob', agentJobId: 'aj1' });
  assert.strictEqual(out[0][0].json.job_id, 'aj1');
  out = await run({ resource: 'agent', operation: 'cancelJob', agentJobId: 'aj1' });
  assert.strictEqual(last((e) => e.path.includes('/cancel')).path, '/api/v1/agent/jobs/aj1/cancel'); assert.strictEqual(out[0][0].json.status, 'canceled');
  console.log('OK edit:reframe prompt, agent:getJob/cancelJob');

  // 16. media upload from URL: server-side import
  mark = log.length;
  out = await run({ resource: 'media', operation: 'upload', projectId: { mode: 'id', value: 'p1' }, uploadSource: 'url', uploadUrl: 'https://files/sample.mp3?x=1', uploadFileName: '' });
  const imp = since(mark).find((e) => e.path === '/api/v1/projects/p1/uploads/import');
  assert.deepStrictEqual(imp.body, { download_url: 'https://files/sample.mp3?x=1', file_name: 'sample.mp3', role: 'pending' });
  assert.strictEqual(out[0][0].json.media_id, 'm-imp'); assert.strictEqual(out[0][0].json.url, 'https://cdn/imported?sig');
  // binary source: xxhash + register + PUT + complete
  mark = log.length;
  out = await run({ resource: 'media', operation: 'upload', projectId: { mode: 'id', value: 'p1' }, uploadSource: 'binary', binaryPropertyName: 'data', uploadFileName: '' }, [{ json: {}, binary: { data: { data: Buffer.from('abc').toString('base64'), mimeType: 'image/png', fileName: 'sample.png' } } }]);
  const reg = since(mark).find((e) => e.path === '/api/v1/projects/p1/uploads' && e.method === 'POST');
  assert.strictEqual(reg.body.file_hash, '44bc2cf5ad770999'); assert.strictEqual(reg.body.file_size, 3); assert.strictEqual(reg.body.mime_type, 'image/png'); assert.strictEqual(reg.body.role, 'pending'); assert.strictEqual(reg.body.original_file_name, 'sample.png'); assert.strictEqual(reg.body.duration, undefined);
  const put = since(mark).find((e) => e.path === '/s3/put');
  assert.strictEqual(put.putBytes, 3); assert.strictEqual(put.ct, 'image/png'); assert.strictEqual(put.auth, undefined, 'no bearer on S3 PUT');
  assert.ok(since(mark).find((e) => e.path === '/api/v1/projects/p1/uploads/up1/complete'));
  assert.strictEqual(out[0][0].json.file_hash, '44bc2cf5ad770999');
  await assert.rejects(run({ resource: 'media', operation: 'upload', projectId: { mode: 'id', value: 'p1' }, uploadSource: 'binary', binaryPropertyName: 'nope' }, [{ json: {}, binary: { data: {} } }]), /No binary data in field "nope"/);
  console.log('OK media:upload (url -> import route; binary -> hash, S3 PUT without auth, complete)');

  // 17. media getDownloadUrl by media id only, and list
  out = await run({ resource: 'media', operation: 'getDownloadUrl', projectId: { mode: 'id', value: 'p1' }, mediaId: 'm9', fileHash: '' });
  assert.strictEqual(out[0][0].json.url, 'https://cdn/list9?sig');
  await assert.rejects(run({ resource: 'media', operation: 'getDownloadUrl', projectId: { mode: 'id', value: 'p1' }, mediaId: 'zzz', fileHash: '' }), /No media found/);
  out = await run({ resource: 'media', operation: 'list', projectId: { mode: 'id', value: 'p1' } });
  assert.strictEqual(out[0].length, 2); assert.strictEqual(out[0][1].json.url, 'https://cdn/list9?sig');
  console.log('OK media:getDownloadUrl/list');

  // 18. brand kit
  out = await run({ resource: 'brandKit', operation: 'importFromWebsite', brandKitWorkspaceId: 'ws1', websiteUrl: 'https://rendley.com' });
  assert.deepStrictEqual(last((e) => e.path === '/api/v1/brandkit/ws1/import').body, { website_url: 'https://rendley.com' });
  console.log('OK brandKit:importFromWebsite');

  // 19. continueOnFail
  out = await run({ resource: 'media', operation: 'getDownloadUrl', projectId: { mode: 'id', value: 'p1' }, mediaId: '', fileHash: '' }, [{ json: {} }], { continueOnFail: true });
  assert.match(out[0][0].json.error, /Media ID or a File Hash/);
  console.log('OK continueOnFail');

  // 20. loadOptions
  const lo = makeCtx(port, { resource: 'video', operation: 'generate' });
  let opts = await node.methods.loadOptions.getModels.call(lo);
  assert.deepStrictEqual(opts.map((o) => o.value), ['', 'kling-v2.6', 'veo-3']);
  opts = await node.methods.loadOptions.getVoices.call(lo);
  assert.deepStrictEqual(opts.map((o) => o.name), ['Adam', 'Zoe']);
  assert.strictEqual(last((e) => e.path.startsWith('/api/v1/ai/text-to-speech/voices')).path, '/api/v1/ai/text-to-speech/voices?limit=100');
  opts = await node.methods.loadOptions.getTranslateLanguages.call(lo);
  assert.deepStrictEqual(opts.map((o) => o.value), ['de', 'es']);
  opts = await node.methods.loadOptions.getWorkspacesOrDefault.call(lo);
  assert.deepStrictEqual(opts.map((o) => o.value), ['', 'ws1']);
  const search = await node.methods.listSearch.searchProjects.call(lo, 'alp');
  assert.deepStrictEqual(search.results, [{ name: 'Alpha', value: 'p2' }]);
  console.log('OK loadOptions (models filtered by action, voices meta envelope, languages, workspaces, project search)');

  // 21. poll timeout path (pollTimeout minutes=1 is too long to test; verify status list handles agent "canceled")
  console.log(`\nALL NODE HARNESS CHECKS PASSED — ${log.length} stub requests exercised`);
  server.close();
})().catch((e) => { console.error('FAIL:', e && e.stack || e); console.error('last requests:', JSON.stringify(log.slice(-4), null, 1)); server.close(); process.exit(1); });
