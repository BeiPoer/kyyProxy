import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { mapRequest, prepareAssets, applyStatus, upstreamClient } from '../adapter.js';
import { configuration, createProxy } from '../server.js';
import { publicAddress, downloadVideo, cleanAssets } from '../media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
test('mapping handles OpenAI fields, model aliases, frames, and multimodal constraints', () => {
  const mapped = mapRequest({ prompt: ' test ', model: 'sora-2', seconds: '8', size: '1792x1024', input_reference: { image_url: 'https://example.com/a.png' } }, 'sd_2.0_special');
  assert.deepEqual(mapped.body, { model: 'sd_2.0_special', prompt: 'test', duration: 8, aspect_ratio: '16:9', resolution: '1080p', first_image: 'https://example.com/a.png' });
  assert.equal(mapped.model, 'sora-2');
  for (const extra of [{ seconds: 3 }, { seconds: true }, { size: '__proto__' }, { model: 'unknown' }, { unknown: 1 }, { generate_audio: 'false' }, { input_reference: { file_id: 'file-x' } }, { first_image: 'https://a.test', reference_images: ['https://b.test'] }, { last_image: 'https://a.test' }, { reference_audios: ['https://a.test'] }, { reference_images: Array(10).fill('https://a.test') }]) {
    assert.throws(() => mapRequest({ prompt: 'test', ...extra }, 'sd_2.0_special'), { status: 400 });
  }
  assert.equal(mapRequest({ prompt: 'test', reference_images: ['assetId://a'], reference_audios: ['https://a.test/a.mp3'], generate_audio: false }, 'sd_2.0_special').body.generate_audio, false);
});

test('asset preparation persists IDs and waits for ACTIVE; rejects failures before generation', async () => {
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
  const job = {}; applyStatus(job, { status: 'processing', progress: 43 }); assert.equal(job.status, 'in_progress');
  applyStatus(job, { status: 'failed', error_message: 'rejected' }); assert.equal(job.error.message, 'rejected');
  assert.throws(() => applyStatus({}, { status: 'other' }), { status: 502 });
});

test('download rejects private networks and unsafe schemes', async () => {
  for (const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','172.16.0.1','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['http://example.com/a.mp4','https://127.0.0.1/a','https://[::1]/a','file:///etc/passwd']) await assert.rejects(downloadVideo(url));
});

async function setup(t, fetcher, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kyy-proxy-test-'));
  const config = configuration({ KYY_API_KEY: 'upstream-secret', PROXY_API_KEY: 'proxy-secret', DATA_DIR: dataDir, PUBLIC_BASE_URL: 'https://proxy.test' });
  const options = { fetch: fetcher, assets: { interval: 1 }, download: async () => Readable.from(['mock-mp4']), ...extra };
  let app = await createProxy(config, options);
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; }
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

test('HTTP create → poll → content, standard routes, auth and persistence after restart', async t => {
  let creates = 0;
  const ctx = await setup(t, async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer upstream-secret');
    if (init.method === 'POST') { creates++; assert.equal(JSON.parse(init.body).duration, 8); return Response.json({ id: 'remote-1', status: 'queued' }); }
    assert.ok(url.endsWith('/v2/model-center/tasks/remote-1'));
    return Response.json({ id: 'remote-1', status: 'completed', result_url: 'https://cdn.test/video.mp4' });
  });
  assert.equal((await fetch(ctx.base + '/healthz')).status, 200);
  assert.equal((await fetch(ctx.base + '/v1/videos')).status, 401);
  assert.equal((await ctx.request('/v1/videos', post({ prompt: 'test', seconds: 2 }))).status, 400);
  assert.equal((await ctx.request('/v1/video', post({ prompt: 'test' }))).status, 404);
  const response = await ctx.request('/v1/videos', post({ prompt: 'test', model: 'sora-2', seconds: '8' }));
  assert.equal(response.status, 200);
  const created = await response.json(); assert.equal(created.status, 'queued');
  const done = await waitFor(async () => (await ctx.request('/v1/videos/' + created.id)).json(), x => x.status === 'completed');
  assert.equal(done.object, 'video'); assert.equal(done.progress, 100); assert.equal(done.model, 'sora-2'); assert.equal(done.upstream_id, 'remote-1');
  assert.equal((await ctx.request('/v1/video/' + created.id)).status, 404);
  assert.equal((await ctx.request('/v1/video/' + created.id + '/content')).status, 404);
  assert.equal(await (await ctx.request('/v1/videos/' + created.id + '/content')).text(), 'mock-mp4');
  await ctx.restart();
  assert.equal((await (await ctx.request('/v1/videos/' + created.id)).json()).status, 'completed');
  assert.equal(creates, 1);
  assert.equal((await ctx.request('/v1/videos/' + created.id + '/content?variant=thumbnail')).status, 400);
  assert.equal((await ctx.request('/v1/videos/' + created.id, { method: 'DELETE' })).status, 501);
});

test('multipart and Base64 image relay, review, expiring URLs and no credential persistence', async t => {
  const bodies = [];
  const ctx = await setup(t, async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (url.endsWith('assetUpload')) { assert.ok(body.url.startsWith('https://proxy.test/assets/')); return Response.json({ assetId: 'asset-1', status: 'PROCESSING' }); }
    if (url.endsWith('assetDetail')) return Response.json({ assetId: 'asset-1', status: 'ACTIVE' });
    assert.equal(body.first_image, 'assetId://asset-1'); return Response.json({ id: 'remote-2', status: 'queued' });
  });
  const form = new FormData(); form.set('prompt', 'animate'); form.set('input_reference', new Blob([png], { type: 'image/png' }), 'input.png');
  const created = await (await ctx.request('/v1/videos', { method: 'POST', body: form })).json();
  assert.ok(created.id);
  await waitFor(async () => bodies.length, x => x === 3);
  const url = new URL(bodies[0].url);
  const image = await fetch(ctx.base + url.pathname);
  assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(ctx.base + '/assets/no-such-file')).status, 404);
  await waitFor(async () => JSON.parse(await readFile(join(ctx.config.dataDir,'jobs',created.id+'.json'),'utf8')), x => x.phase === 'submitted');
  const stored = await readFile(join(ctx.config.dataDir,'jobs',created.id+'.json'),'utf8');
  assert.ok(!stored.includes('secret')); assert.ok(!stored.includes('base64'));
  const data = 'data:image/png;base64,' + png.toString('base64');
  const response = await ctx.request('/v1/videos', post({ prompt: 'base64', input_reference: { image_url: data } })); assert.equal(response.status, 200);
  assert.equal((await ctx.request('/v1/videos', post({ prompt: 'bad', input_reference: { image_url: data, file_id: 'extra' } }))).status, 400);
  const expired = '1000000000000-' + 'a'.repeat(48) + '.png';
  await writeFile(join(ctx.config.dataDir,'assets',expired), png);
  assert.equal((await fetch(ctx.base + '/assets/' + expired)).status, 404);
  await cleanAssets(ctx.config); assert.ok(!(await readdir(join(ctx.config.dataDir,'assets'))).includes(expired));
});

test('ambiguous submit is not retried, and interrupted submit is marked uncertain after restart', async t => {
  let calls = 0;
  const ctx = await setup(t, async () => { calls++; throw new Error('network broke'); });
  const created = await (await ctx.request('/v1/videos', post({ prompt: 'test' }))).json();
  const job = await waitFor(async () => (await ctx.request('/v1/videos/' + created.id)).json(), x => x.status === 'failed');
  assert.equal(job.error.code, 'submission_uncertain'); assert.equal(calls, 1, JSON.stringify(job));
  const path = join(ctx.config.dataDir,'jobs',created.id+'.json');
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.phase = 'submitting'; saved.status = 'queued';
  await writeFile(path, JSON.stringify(saved)); await ctx.restart();
  assert.equal((await (await ctx.request('/v1/videos/' + created.id)).json()).error.code, 'submission_uncertain'); assert.equal(calls, 1);
});

test('restart resumes saved asset review and preserves upstream errors for callers', async t => {
  const calls = [];
  const ctx = await setup(t, async (url, init) => {
    calls.push(url);
    if (url.endsWith('assetDetail')) { assert.equal(JSON.parse(init.body).assetId, 'saved-asset'); return Response.json({ assetId: 'saved-asset', status: 'ACTIVE' }); }
    if (init.method === 'POST') return Response.json({ id: 'recovered', status: 'queued' });
    return Response.json({ status: 'failed', error_message: '上游拒绝 upstream-secret' });
  });
  const id = 'video_00000000-0000-4000-8000-000000000000';
  const job = { ...mapRequest({ prompt: 'resume', first_image: 'assetId://saved-asset' }, 'sd_2.0_special'), id, phase: 'preparing', status: 'queued', progress: 0, created_at: 1 };
  await writeFile(join(ctx.config.dataDir,'jobs',id+'.json'), JSON.stringify(job));
  await ctx.restart();
  const result = await waitFor(async () => (await ctx.request('/v1/videos/' + id)).json(), x => x.status === 'failed');
  assert.equal(result.error.message, '上游拒绝 [redacted]');
  assert.ok(!calls.some(url => url.endsWith('assetUpload')));
  assert.equal((await ctx.request('/v1/videos/' + id + '/content')).status, 409);
});
