import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { mapRequest, prepareAssets, applyStatus, upstreamClient, taskObject } from '../adapter.js';
import { configuration, createProxy } from '../server.js';
import { cleanAssets } from '../media.js';

const path = '/api/v3/contents/generations/tasks';
const model = 'doubao-seedance-2-0-260128';
const text = value => ({ type: 'text', text: value });
const media = (type, url, role) => ({ type, [type]: { url }, ...(role ? { role } : {}) });
const input = extra => ({ model, content: [text('test')], ...extra });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
const dataUrl = 'data:image/png;base64,' + png.toString('base64');

test('Ark content, model and video options map to kyy fields', () => {
  const mapped = mapRequest(input({ content: [text(' test '), media('image_url','https://example.com/a.png')], duration: 8, ratio: '16:9', resolution: '1080p', generate_audio: false, watermark: true, seed: 123, tools: [{ type: 'web_search' }] }));
  assert.deepEqual(mapped, { model, body: { model: 'sd_2.0_special', prompt: 'test', duration: 8, aspect_ratio: '16:9', resolution: '1080p', first_image: 'https://example.com/a.png', generate_audio: false, watermark: true, seed: 123, tools: [{ type: 'web_search' }] } });
  const defaults = mapRequest(input()).body;
  assert.equal(defaults.duration, 5); assert.equal(defaults.aspect_ratio, 'adaptive'); assert.equal(defaults.resolution, '720p');
  assert.equal(mapRequest(input({ model: 'doubao-seedance-2-0-fast-260128' })).body.model, 'sd_2.0_fast_special');
  assert.equal(mapRequest(input({ model: 'doubao-seedance-2-0-mini-260615' })).body.model, 'sd_2.0_mini_special');
  assert.equal(mapRequest(input({ model: 'sd_2.0_discount' })).body.model, 'sd_2.0_discount');
  const refs = mapRequest(input({ content: [text('one'), text('two'), media('image_url','assetId://image','reference_image'), media('video_url','https://example.com/v.mp4','reference_video'), media('audio_url','https://example.com/a.mp3','reference_audio')] })).body;
  assert.equal(refs.prompt, 'one\ntwo'); assert.deepEqual(refs.reference_images, ['assetId://image']);
  assert.deepEqual(refs.reference_videos, ['https://example.com/v.mp4']); assert.deepEqual(refs.reference_audios, ['https://example.com/a.mp3']);
});

test('rejects OpenAI fields, unsupported Ark capabilities and malformed content', () => {
  for (const extra of [
    { model: undefined }, { model: 'sora-2' }, { model: '__proto__' },
    { prompt: 'old' }, { seconds: '8' }, { size: '720x1280' }, { input_reference: {} },
    { duration: -1 }, { duration: '8' }, { duration: 16 }, { ratio: 'bad' }, { resolution: '480p' },
    { callback_url: 'https://example.com' }, { return_last_frame: true }, { frames: 121 }, { generate_audio: 'false' },
    { seed: 2147483648 }, { tools: [{ type: 'unknown' }] }, { content: [] }, { content: null },
    { content: [text('test --dur 8')] }, { content: [media('image_url','https://example.com/a.png')] },
    { content: [text('test'), { type: 'draft_task', draft_task: { id: 'x' } }] },
    { content: [text('test'), media('image_url','asset://official','first_frame')] },
    { content: [text('test'), media('image_url','javascript:alert(1)','first_frame')] },
    { content: [text('test'), media('image_url','https://example.com/a.png','last_frame')] },
    { content: [text('test'), media('image_url','https://example.com/a.png'), media('image_url','https://example.com/b.png')] },
    { content: [text('test'), media('image_url','https://example.com/a.png'), media('image_url','https://example.com/b.png','reference_image')] },
    { content: [text('test'), media('audio_url','https://example.com/a.mp3','reference_audio')] },
    { content: [text('test'), media('video_url','https://example.com/v.mp4')] },
    { content: [text('test'), media('audio_url','data:audio/wav;base64,YQ==','reference_audio')] },
    { content: [text('test'), ...Array(10).fill(media('image_url','https://example.com/a.png','reference_image'))] },
    { content: [text('test'), ...Array(4).fill(media('video_url','https://example.com/v.mp4','reference_video'))] },
  ]) assert.throws(() => mapRequest(input(extra)), { status: 400 }, JSON.stringify(extra));
  for (const body of [null, [], 'bad']) assert.throws(() => mapRequest(body), { status: 400 });
});

test('asset review persists IDs and handles failures and timeouts', async () => {
  const body = { model: 'sd_2.0_fast_special', first_image: 'https://example.com/a.png' };
  let calls = 0, saves = 0;
  await prepareAssets(body, async (path, request) => {
    calls++;
    if (calls === 1) { assert.equal(path, '/asset/seedance2/assetUpload'); assert.equal(request.model, 'sd_fast'); return { assetId: 'a', status: 'PROCESSING' }; }
    assert.equal(path, '/asset/seedance2/assetDetail'); assert.deepEqual(request, { assetId: 'a' });
    return { assetId: 'a', status: 'ACTIVE' };
  }, async () => { saves++; assert.equal(body.first_image, 'assetId://a'); }, { interval: 1 });
  assert.equal(saves, 1); assert.equal(calls, 2);
  await assert.rejects(prepareAssets(body, async () => ({ assetId: 'a', status: 'FAILED' }), async () => {}), { code: 'asset_failed' });
  await assert.rejects(prepareAssets(body, async () => ({ assetId: 'a', status: 'PROCESSING' }), async () => {}, { timeout: 0 }), { code: 'asset_timeout' });
});

test('upstream wrappers, failures and credential redaction', async () => {
  const config = { base: 'https://upstream.test', upstreamKey: 'secret-key' };
  assert.deepEqual(await upstreamClient(config, async () => Response.json({ code: 200, data: { id: 'x' } }))('/test'), { id: 'x' });
  await assert.rejects(upstreamClient(config, async () => Response.json({ code: 500, message: 'bad secret-key' }))('/test'), /bad \[redacted\]/);
  await assert.rejects(upstreamClient(config, async () => new Response('html'))('/test'), { code: 'upstream_invalid_response' });
});

test('maps task states and returns Ark content without OpenAI fields or invented usage', () => {
  for (const [source, target] of [['queued','queued'],['processing','running'],['completed','succeeded'],['failed','failed'],['cancelled','cancelled'],['expired','expired']]) {
    const job = { ...mapRequest(input()), id: 'cgt-test', created_at: 10, updated_at: 11 };
    applyStatus(job, { status: source, video_url: 'https://cdn.test/video.mp4', error_message: 'rejected' });
    const result = taskObject(job);
    assert.equal(result.status, target); assert.equal(result.updated_at, 11);
    for (const field of ['usage','object','seconds','size','progress']) assert.equal(result[field], undefined);
    assert.deepEqual(result.content, target === 'succeeded' ? { video_url: 'https://cdn.test/video.mp4' } : {});
  }
  const job = { ...mapRequest(input()), status: 'running' };
  assert.throws(() => applyStatus(job, { status: 'completed' }), { status: 502 }); assert.equal(job.status, 'running');
  assert.throws(() => applyStatus(job, { status: '__proto__' }), { status: 502 });
  applyStatus(job, { status: 'completed', result_url: 'https://cdn.test/video.mp4', actualDuration: 6, usage: { total_tokens: 123 } });
  assert.equal(taskObject(job).duration, 6); assert.deepEqual(taskObject(job).usage, { completion_tokens: 123, total_tokens: 123 });
});

async function setup(t, fetcher) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kyy-proxy-test-'));
  const config = configuration({ KYY_API_KEY: 'upstream-secret', PROXY_API_KEY: 'proxy-secret', DATA_DIR: dataDir, PUBLIC_BASE_URL: 'https://proxy.test' });
  const options = { fetch: fetcher, assets: { interval: 1 } };
  let app = await createProxy(config, options);
  async function listen() {
    for (;;) {
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      const port = app.server.address().port;
      // Windows can allocate ephemeral ports that the Fetch standard blocks.
      if (![2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080].includes(port)) return 'http://127.0.0.1:' + port;
      await new Promise(resolve => app.server.close(resolve));
    }
  }
  let base = await listen();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    config, get base() { return base; },
    request: (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: 'Bearer proxy-secret', ...init.headers } }),
    async restart() { await app.close(); app = await createProxy(config, options); base = await listen(); },
  };
}
async function waitFor(f, predicate) {
  let value;
  for (let attempt = 0; attempt < 100; attempt++) { value = await f(); if (predicate(value)) return value; await sleep(10); }
  assert.fail('Timed out waiting for test task: ' + JSON.stringify(value));
}
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP Ark create/poll contract, legacy route removal, authentication and restart', async t => {
  let creates = 0, queries = 0;
  const ctx = await setup(t, async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer upstream-secret');
    if (init.method === 'POST') { creates++; assert.equal(JSON.parse(init.body).duration, 8); return Response.json({ id: 'remote-1', status: 'queued' }); }
    assert.ok(url.endsWith('/v2/model-center/tasks/remote-1')); queries++;
    return Response.json(queries === 1 ? { status: 'processing' } : { status: 'completed', result_url: 'https://cdn.test/video.mp4' });
  });
  assert.equal((await fetch(ctx.base + '/healthz')).status, 200);
  assert.equal((await fetch(ctx.base + path)).status, 401);
  for (const legacy of ['/v1/videos','/v1/video','/v1/models']) assert.equal((await ctx.request(legacy)).status, 404);
  const bad = await ctx.request(path, post(input({ duration: 2 })));
  assert.equal(bad.status, 400); const error = await bad.json(); assert.ok(error.error.code); assert.ok(error.error.message); assert.equal(error.error.type, undefined);
  const form = new FormData(); form.set('prompt', 'no multipart');
  assert.equal((await ctx.request(path, { method: 'POST', body: form })).status, 415);
  const response = await ctx.request(path, post(input({ duration: 8 })));
  assert.equal(response.status, 200); const created = await response.json();
  assert.deepEqual(Object.keys(created), ['id']); assert.match(created.id, /^cgt-/);
  const running = await waitFor(async () => (await ctx.request(path + '/' + created.id)).json(), x => x.status === 'running');
  assert.deepEqual(running.content, {});
  const done = await (await ctx.request(path + '/' + created.id)).json();
  assert.equal(done.status, 'succeeded'); assert.equal(done.model, model); assert.equal(done.content.video_url, 'https://cdn.test/video.mp4');
  assert.equal(done.duration, 8); assert.equal(done.ratio, 'adaptive'); assert.ok(done.updated_at >= done.created_at);
  assert.equal(done.video_url, undefined); assert.equal(done.object, undefined); assert.equal(done.upstream_id, undefined);
  await ctx.restart();
  assert.equal((await (await ctx.request(path + '/' + created.id)).json()).status, 'succeeded'); assert.equal(creates, 1);
  assert.equal((await ctx.request(path + '/' + created.id + '/content')).status, 404);
  assert.equal((await ctx.request(path + '/' + created.id, { method: 'DELETE' })).status, 501);
  assert.equal((await ctx.request(path)).status, 501);
});

test('Base64 reference images are relayed, reviewed and persisted without credentials', async t => {
  const bodies = [];
  const ctx = await setup(t, async (url, init) => {
    if (init.method === 'GET') return Response.json({ status: 'completed', video_url: 'https://cdn.test/video.mp4' });
    const body = JSON.parse(init.body); bodies.push(body);
    if (url.endsWith('assetUpload')) { assert.ok(body.url.startsWith('https://proxy.test/assets/')); return Response.json({ assetId: 'asset-1', status: 'PROCESSING' }); }
    if (url.endsWith('assetDetail')) return Response.json({ assetId: 'asset-1', status: 'ACTIVE' });
    assert.deepEqual(body.reference_images, ['assetId://asset-1']); return Response.json({ id: 'remote-2', status: 'queued' });
  });
  const response = await ctx.request(path, post(input({ content: [text('animate'), media('image_url',dataUrl,'reference_image')] })));
  assert.equal(response.status, 200); const created = await response.json();
  await waitFor(async () => bodies.length, x => x === 3);
  const image = await fetch(ctx.base + new URL(bodies[0].url).pathname);
  assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(ctx.base + '/assets/no-such-file')).status, 404);
  await waitFor(async () => (await ctx.request(path + '/' + created.id)).json(), x => x.status === 'succeeded');
  const stored = JSON.parse(await readFile(join(ctx.config.dataDir,'jobs',created.id+'.json'),'utf8'));
  assert.ok(!JSON.stringify(stored).includes('secret')); assert.ok(!JSON.stringify(stored).includes('base64'));
  const invalid = input({ content: [text('bad'), media('image_url','data:image/png;base64,YQ==')] });
  assert.equal((await ctx.request(path, post(invalid))).status, 400);
  const expired = '1000000000000-' + 'a'.repeat(48) + '.png';
  await writeFile(join(ctx.config.dataDir,'assets',expired), png);
  assert.equal((await fetch(ctx.base + '/assets/' + expired)).status, 404);
  await cleanAssets(ctx.config); assert.ok(!(await readdir(join(ctx.config.dataDir,'assets'))).includes(expired));
});

test('first and last frames upload independently before task submission', async t => {
  let uploads = 0;
  const ctx = await setup(t, async (url, init) => {
    if (init.method === 'GET') return Response.json({ status: 'completed', video_url: 'https://cdn.test/frames.mp4' });
    const body = JSON.parse(init.body);
    if (url.endsWith('assetUpload')) { uploads++; return Response.json({ assetId: 'asset-' + uploads, status: 'ACTIVE' }); }
    assert.equal(body.first_image, 'assetId://asset-1'); assert.equal(body.last_image, 'assetId://asset-2');
    return Response.json({ id: 'remote-frames', status: 'completed', video_url: 'https://cdn.test/frames.mp4' });
  });
  const created = await (await ctx.request(path, post(input({ content: [text('frames'), media('image_url',dataUrl,'first_frame'), media('image_url',dataUrl,'last_frame')] })))).json();
  await waitFor(async () => (await ctx.request(path + '/' + created.id)).json(), x => x.status === 'succeeded');
  assert.equal(uploads, 2);
});

test('ambiguous submission is not retried across restarts', async t => {
  let calls = 0;
  const ctx = await setup(t, async () => { calls++; throw new Error('network broke'); });
  const created = await (await ctx.request(path, post(input()))).json();
  const job = await waitFor(async () => (await ctx.request(path + '/' + created.id)).json(), x => x.status === 'failed');
  assert.equal(job.error.code, 'submission_uncertain'); assert.equal(calls, 1);
  const file = join(ctx.config.dataDir,'jobs',created.id+'.json');
  const saved = JSON.parse(await readFile(file, 'utf8')); saved.phase = 'submitting'; saved.status = 'queued';
  await writeFile(file, JSON.stringify(saved)); await ctx.restart();
  assert.equal((await (await ctx.request(path + '/' + created.id)).json()).error.code, 'submission_uncertain'); assert.equal(calls, 1);
});

test('old task records remain queryable and unfinished asset preparation resumes', async t => {
  const calls = [];
  const ctx = await setup(t, async (url, init) => {
    calls.push(url);
    if (url.endsWith('assetDetail')) { assert.equal(JSON.parse(init.body).assetId, 'saved-asset'); return Response.json({ assetId: 'saved-asset', status: 'ACTIVE' }); }
    if (init.method === 'POST') return Response.json({ id: 'recovered', status: 'queued' });
    return Response.json({ status: 'failed', error_message: '上游拒绝 upstream-secret' });
  });
  const id = 'video_00000000-0000-4000-8000-000000000000';
  const oldJob = { body: { model: 'sd_2.0_special', prompt: 'old', duration: 8, aspect_ratio: '16:9', resolution: '720p', generate_audio: false }, model: 'sora-2', seconds: '8', size: '1280x720', id, phase: 'submitted', status: 'completed', video_url: 'https://cdn.test/old.mp4', created_at: 1 };
  await writeFile(join(ctx.config.dataDir,'jobs',id+'.json'), JSON.stringify(oldJob));
  const pendingId = 'video_11111111-1111-4111-8111-111111111111';
  await writeFile(join(ctx.config.dataDir,'jobs',pendingId+'.json'), JSON.stringify({ ...oldJob, id: pendingId, body: { ...oldJob.body, first_image: 'assetId://saved-asset' }, status: 'queued', phase: 'preparing' }));
  await ctx.restart();
  const oldResult = await (await ctx.request(path + '/' + id)).json();
  assert.equal(oldResult.status, 'succeeded'); assert.equal(oldResult.model, 'sd_2.0_special'); assert.equal(oldResult.content.video_url, oldJob.video_url); assert.equal(oldResult.seconds, undefined);
  const result = await waitFor(async () => (await ctx.request(path + '/' + pendingId)).json(), x => x.status === 'failed');
  assert.equal(result.error.message, '上游拒绝 [redacted]'); assert.deepEqual(result.content, {});
  assert.ok(!calls.some(url => url.endsWith('assetUpload')));
});
