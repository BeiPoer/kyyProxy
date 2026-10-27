import http from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail, httpUrl, models, mapRequest, upstreamClient, prepareAssets, applyStatus, videoObject } from './adapter.js';
import { saveImage, serveImage, cleanAssets, downloadVideo } from './media.js';

export function configuration(env = process.env) {
  const config = {
    port: Number(env.PORT || 8080), dataDir: resolve(env.DATA_DIR || './data'),
    base: httpUrl(env.KYY_BASE_URL || 'https://zcbservice.aizfw.cn/kyyReactApiServer').replace(/\/+$/, ''),
    upstreamKey: env.KYY_API_KEY?.trim(), proxyKey: env.PROXY_API_KEY?.trim(),
    defaultModel: env.KYY_MODEL || 'sd_2.0_special', publicBase: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  };
  if (!config.upstreamKey || !config.proxyKey) throw new Error('请在 .env 配置 KYY_API_KEY 和 PROXY_API_KEY');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT 必须为 1–65535');
  if (!models.includes(config.defaultModel)) throw new Error('KYY_MODEL 必须是支持的 Seedance 2.0 模型');
  for (const address of [config.base, config.publicBase].filter(Boolean)) {
    const url = new URL(address);
    if (url.search || url.hash || url.username || url.password) throw new Error('服务地址不能包含查询参数、片段或用户名密码');
  }
  if (config.publicBase && new URL(config.publicBase).protocol !== 'https:') throw new Error('PUBLIC_BASE_URL 必须为公网 HTTPS 地址');
  return config;
}

const jobPattern = /^video_[a-f0-9-]{36}$/;
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 42 * 1024 * 1024) throw fail('请求体超过 42 MiB', 413);
    chunks.push(chunk);
  }
  const contentType = req.headers['content-type'] || '';
  const bytes = Buffer.concat(chunks);
  try {
    if (contentType.startsWith('application/json')) return JSON.parse(bytes.toString('utf8'));
    if (contentType.startsWith('multipart/form-data')) {
      const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
      const input = Object.create(null);
      for (const [key, value] of form) {
        if (Object.hasOwn(input, key)) throw fail(`参数 ${key} 不可重复`);
        if (typeof value !== 'string' && key !== 'input_reference') throw fail('只允许 input_reference 上传文件');
        input[key] = value;
      }
      for (const key of ['reference_images','reference_videos','reference_audios','generate_audio','watermark','seed']) if (typeof input[key] === 'string') input[key] = JSON.parse(input[key]);
      if (typeof input.input_reference === 'string' && input.input_reference.startsWith('{')) input.input_reference = JSON.parse(input.input_reference);
      return input;
    }
  } catch (error) { if (error.status) throw error; throw fail('JSON 或 multipart 请求体格式错误'); }
  throw fail('Content-Type 必须为 application/json 或 multipart/form-data', 415);
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function createProxy(config, options = {}) {
  for (const folder of ['jobs', 'assets']) await mkdir(join(config.dataDir, folder), { recursive: true });
  const call = upstreamClient(config, options.fetch);
  const controller = new AbortController();
  const pending = [], active = new Set(), refreshing = new Map();
  // shortcut: one process owns this file store; use a transactional database before running multiple replicas.
  const digest = value => createHash('sha256').update(value).digest();
  const jobPath = id => join(config.dataDir, 'jobs', id + '.json');
  async function save(job) {
    const temp = jobPath(job.id) + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(job), { mode: 0o600 });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, jobPath(job.id)); break; }
        catch (error) {
          // Windows briefly denies replacement while a concurrent poll has the file open.
          if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 20) throw error;
          await sleep(25);
        }
      }
    } finally { await rm(temp, { force: true }); }
  }
  async function load(id) {
    if (!jobPattern.test(id)) throw fail('任务不存在', 404, 'not_found');
    try { return JSON.parse(await readFile(jobPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail('任务不存在', 404, 'not_found'); throw error; }
  }
  function safeMessage(error) { return String(error.message || '请求失败').split(config.upstreamKey).join('[redacted]').split(config.proxyKey).join('[redacted]').slice(0, 1500); }
  async function run(job) {
    try {
      await prepareAssets(job.body, call, () => save(job), { ...options.assets, signal: controller.signal });
      controller.signal.throwIfAborted();
      // Persist before the paid POST; after an interrupted submit, never silently resubmit.
      job.phase = 'submitting'; await save(job);
      const upstream = await call('/v2/model-center/tasks', job.body);
      if (typeof upstream.id !== 'string' || !upstream.id || upstream.id.length > 300) throw fail('提交后未返回任务 ID', 502, 'submission_uncertain');
      job.remoteId = upstream.id; job.phase = 'submitted';
      try { applyStatus(job, upstream); } catch { /* A later GET can recover an incomplete initial response. */ }
      if (job.error) job.error.message = safeMessage(job.error);
      await save(job);
    } catch (error) {
      if (controller.signal.aborted && job.phase === 'preparing') return;
      if (job.remoteId) {
        console.error(`任务 ${job.id} 已提交，上游 ID ${job.remoteId}，保存失败：`, safeMessage(error));
        return;
      }
      job.status = 'failed';
      job.error = { code: job.phase === 'submitting' ? 'submission_uncertain' : (error.code || 'asset_error'), message: safeMessage(error) + (job.phase === 'submitting' ? '；提交结果不确定，请核对上游记录后再重试，避免重复扣费。' : '') };
      job.phase = 'failed'; await save(job);
    }
  }
  function drain() {
    while (!controller.signal.aborted && pending.length && active.size < 4) {
      const task = run(pending.shift()).catch(error => console.error('任务持久化失败：', safeMessage(error))).finally(() => { active.delete(task); drain(); });
      active.add(task);
    }
  }
  async function refresh(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const task = (async () => {
      const job = await load(id);
      if (job.remoteId && !['completed','failed'].includes(job.status)) {
        const upstream = await call('/v2/model-center/tasks/' + encodeURIComponent(job.remoteId));
        applyStatus(job, upstream);
        if (job.error) job.error.message = safeMessage(job.error);
        await save(job);
      }
      return job;
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, task); return task;
  }
  for (const file of await readdir(join(config.dataDir, 'jobs'))) {
    if (!file.endsWith('.json') || !jobPattern.test(file.slice(0,-5))) continue;
    const job = await load(file.slice(0,-5));
    if (job.phase === 'preparing') pending.push(job);
    if (job.phase === 'submitting') {
      job.phase = 'failed'; job.status = 'failed'; job.error = { code: 'submission_uncertain', message: '代理在提交任务期间重启；请核对上游记录后再重试，避免重复扣费。' }; await save(job);
    }
  }
  await cleanAssets(config);
  const cleaner = setInterval(() => cleanAssets(config).catch(error => console.error('素材清理失败：', safeMessage(error))), 3600000);
  cleaner.unref();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/$/, '');
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      if (path.startsWith('/assets/') && ['GET','HEAD'].includes(req.method)) return await serveImage(path.slice(8), config, res, req.method === 'HEAD');
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] || '';
      if (!timingSafeEqual(digest(token), digest(config.proxyKey))) throw fail('无效的代理 API Key', 401, 'invalid_api_key');
      if (path === '/v1/models' && req.method === 'GET') return json(res, 200, { object: 'list', data: [...models,'sora-2','sora-2-pro'].map(id => ({ id, object: 'model', created: 0, owned_by: 'kyyProxy' })) });
      const route = /^\/v1\/videos(?:\/([^/]+)(\/content)?)?$/.exec(path);
      if (!route) throw fail('接口不存在', 404, 'not_found');
      if (req.method === 'POST' && !route[1]) {
        if (pending.length + active.size >= 100) throw fail('素材准备队列已满，请稍后重试', 429, 'queue_full');
        const input = await readBody(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('请求体必须是对象');
        const ref = input.input_reference;
        if (ref && typeof ref === 'object' && !(ref instanceof Blob) && (Object.keys(ref).length !== 1 || typeof ref.image_url !== 'string')) throw fail('input_reference 仅支持 image_url，不支持 OpenAI file_id');
        const upload = ref instanceof Blob ? ref : typeof ref === 'string' && ref.startsWith('data:') ? ref : ref?.image_url?.startsWith?.('data:') ? ref.image_url : null;
        // Validate all other parameters before persisting the uploaded image.
        const mapped = mapRequest(upload ? { ...input, input_reference: { image_url: 'https://validation.invalid/image' } } : input, config.defaultModel);
        if (upload) mapped.body.first_image = await saveImage(upload, config);
        const job = { ...mapped, id: 'video_' + randomUUID(), created_at: Math.floor(Date.now()/1000), status: 'queued', progress: 0, phase: 'preparing' };
        await save(job); json(res, 200, videoObject(job)); pending.push(job); drain(); return;
      }
      if (req.method === 'GET' && route[1]) {
        const job = await refresh(route[1]);
        if (!route[2]) return json(res, 200, videoObject(job));
        if (url.searchParams.has('variant') && url.searchParams.get('variant') !== 'video') throw fail('仅支持 variant=video');
        if (job.status !== 'completed') throw fail('视频尚未生成成功', 409, 'video_not_ready');
        const stream = await (options.download || downloadVideo)(job.video_url);
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="${job.id}.mp4"`, 'cache-control': 'no-store' });
        let size = 0;
        const limit = new Transform({ transform(chunk, encoding, done) { size += chunk.length; done(size > 512 * 1024 * 1024 ? fail('视频超过 512 MiB', 502) : null, chunk); } });
        await pipeline(stream, limit, res); return;
      }
      throw fail('仅支持创建、查询和下载视频；不支持列表、删除或 Remix', 501, 'not_implemented');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || 500;
      json(res, status, { error: { message: status === 500 ? '代理内部错误，请查看服务日志' : safeMessage(error), type: status >= 500 ? 'server_error' : 'invalid_request_error', code: error.code || 'internal_error', param: null } });
      if (status === 500) console.error(safeMessage(error));
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  async function close() {
    controller.abort(); clearInterval(cleaner);
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.allSettled([...active, ...refreshing.values()]);
  }
  drain();
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = configuration();
    const app = await createProxy(config);
    app.server.listen(config.port, '0.0.0.0', () => console.log(`kyyProxy listening on :${config.port}`));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
