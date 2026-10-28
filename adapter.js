import { setTimeout as sleep } from 'node:timers/promises';

export const models = ['sd_2.0_special', 'sd_2.0_fast_special', 'sd_2.0_mini_special', 'sd_2.0_discount', 'sd_2.0_fast_discount', 'sd_2.0_mini_discount'];
const modelMap = {
  'doubao-seedance-2-0-260128': 'sd_2.0_special',
  'doubao-seedance-2-0-fast-260128': 'sd_2.0_fast_special',
  'doubao-seedance-2-0-mini-260615': 'sd_2.0_mini_special',
};
export function fail(message, status = 400, code = 'invalid_request_error') {
  return Object.assign(new Error(message), { status, code });
}
export function httpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('素材必须是 HTTP(S) URL 或 assetId://ID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('不支持的素材 URL');
  return url.href;
}
function reference(value, type) {
  if (typeof value !== 'string') throw fail('素材引用必须是字符串');
  if (value.startsWith('asset://')) throw fail('火山素材 ID 不能跨平台使用，请提供公网 URL、图片 Base64 或 kyy assetId://ID');
  if (value.startsWith('data:')) {
    if (type !== 'image_url' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail('Base64 仅支持 PNG、JPEG、WebP 图片；视频和音频请使用公网 URL');
    return value;
  }
  return /^assetId:\/\/[\w-]+$/.test(value) ? value : httpUrl(value);
}

export function mapRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('请求体必须是对象');
  const allowed = new Set(['model', 'content', 'duration', 'ratio', 'resolution', 'generate_audio', 'watermark', 'seed', 'tools']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw fail(`不支持参数 ${key}`);
  const model = input.model;
  if (typeof model !== 'string' || (!models.includes(model) && !Object.hasOwn(modelMap, model))) throw fail('model 必填，请使用 README 中的 Seedance 2.0 模型 ID');
  const duration = input.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw fail('kyy duration 必须为 4–15 的整数，不支持 -1 自动时长');
  const ratio = input.ratio ?? 'adaptive';
  if (!['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'].includes(ratio)) throw fail('不支持的 ratio');
  const resolution = input.resolution ?? '720p';
  if (!['720p','1080p','4k'].includes(resolution)) throw fail('resolution 支持 720p、1080p、4k；kyy 不支持 480p');
  const body = { model: Object.hasOwn(modelMap, model) ? modelMap[model] : model, prompt: '', duration, aspect_ratio: ratio, resolution, generate_audio: true, watermark: false };
  for (const name of ['generate_audio', 'watermark']) {
    if (input[name] !== undefined) {
      if (typeof input[name] !== 'boolean') throw fail(`${name} 必须是布尔值`);
      body[name] = input[name];
    }
  }
  if (input.seed !== undefined) {
    if (!Number.isInteger(input.seed) || input.seed < -1 || input.seed > 2147483647) throw fail('seed 必须为 -1 至 2147483647 的整数');
    body.seed = input.seed;
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > 1 || input.tools.some(tool => !tool || typeof tool !== 'object' || Object.keys(tool).length !== 1 || tool.type !== 'web_search')) throw fail('tools 仅支持 [{"type":"web_search"}]');
    body.tools = input.tools;
  }
  if (!Array.isArray(input.content) || !input.content.length) throw fail('content 必须是非空数组');
  const texts = [];
  for (const item of input.content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('content 元素必须是对象');
    if (item.type === 'text') {
      if (Object.keys(item).some(key => !['type','text'].includes(key)) || typeof item.text !== 'string' || !item.text.trim()) throw fail('text 元素必须包含非空 text');
      if (/(?:^|\s)--(?:rs|rt|dur|seed|cf|wm|resolution|ratio|duration|frames|camera_fixed|watermark)(?:\s|=|$)/.test(item.text)) throw fail('不支持提示词中的 --参数，请使用请求体的 duration、ratio、resolution 等字段');
      texts.push(item.text.trim()); continue;
    }
    if (!['image_url','video_url','audio_url'].includes(item.type)) throw fail('content.type 仅支持 text、image_url、video_url、audio_url');
    const media = item[item.type];
    if (Object.keys(item).some(key => !['type','role',item.type].includes(key)) || !media || typeof media !== 'object' || Object.keys(media).length !== 1 || typeof media.url !== 'string') throw fail(`${item.type} 必须为 {"url":"..."}`);
    const role = item.role ?? (item.type === 'image_url' ? 'first_frame' : undefined);
    const roles = item.type === 'image_url' ? ['first_frame','last_frame','reference_image'] : item.type === 'video_url' ? ['reference_video'] : ['reference_audio'];
    if (!roles.includes(role)) throw fail(`${item.type} 的 role 必须为 ${roles.join('、')}`);
    const value = reference(media.url, item.type);
    const field = { first_frame: 'first_image', last_frame: 'last_image', reference_image: 'reference_images', reference_video: 'reference_videos', reference_audio: 'reference_audios' }[role];
    if (role === 'first_frame' || role === 'last_frame') {
      if (body[field]) throw fail(`${role} 只能提供一张图片`);
      body[field] = value;
    } else (body[field] ||= []).push(value);
  }
  body.prompt = texts.join('\n');
  if (!body.prompt || body.prompt.length > 32000) throw fail('kyy 要求至少一个 text 提示词，合计 1–32000 字符');
  for (const [key, max] of [['reference_images',9],['reference_videos',3],['reference_audios',3]]) if (body[key]?.length > max) throw fail(`${key} 最多 ${max} 个素材`);
  if ((body.first_image || body.last_image) && (body.reference_images || body.reference_videos || body.reference_audios)) throw fail('首尾帧不能与多模态参考素材混用');
  if (body.last_image && !body.first_image) throw fail('last_frame 需要 first_frame');
  if (body.reference_audios && !body.reference_images && !body.reference_videos) throw fail('音频参考需要同时提供图片或视频');
  return { body, model };
}

export function upstreamClient(config, fetcher = fetch) {
  return async (path, body) => {
    let response;
    try {
      response = await fetcher(config.base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${config.upstreamKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
      });
    } catch { throw fail('上游请求超时或连接失败', 502, 'upstream_connection_error'); }
    let value;
    try { value = await response.json(); } catch { throw fail('上游返回非 JSON 响应', 502, 'upstream_invalid_response'); }
    if (!response.ok || (value?.code != null && ![0, 200].includes(Number(value.code)))) {
      const message = value?.error?.message || value?.error_message || value?.errorMessage || value?.message || value?.msg || '上游请求失败';
      throw fail(String(message).split(config.upstreamKey).join('[redacted]').slice(0, 1000), response.status === 429 ? 429 : 502, 'upstream_error');
    }
    value = value?.data && typeof value.data === 'object' ? value.data : value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('上游返回无效对象', 502, 'upstream_invalid_response');
    return value;
  };
}

export async function prepareAssets(body, call, save, { signal, interval = 5000, timeout = 600000 } = {}) {
  const deadline = Date.now() + timeout;
  const family = body.model.includes('_fast_') ? 'sd_fast' : body.model.includes('_mini_') ? 'sd_mini' : 'sd';
  async function prepare(value, kind, update) {
    signal?.throwIfAborted();
    let asset = await call(value.startsWith('assetId://') ? '/asset/seedance2/assetDetail' : '/asset/seedance2/assetUpload',
      value.startsWith('assetId://') ? { assetId: value.slice(10) } : { assetType: kind, url: value, name: 'kyyProxy reference', model: family });
    if (typeof asset.assetId !== 'string' || !/^[\w-]+$/.test(asset.assetId)) throw fail('上游未返回有效素材 ID', 502, 'invalid_asset');
    const id = asset.assetId;
    update(`assetId://${id}`);
    await save();
    while (asset.status !== 'ACTIVE') {
      if (['FAILED', 'DELETED'].includes(asset.status)) throw fail(`素材 ${id} 审核失败：${asset.errorMessage || asset.status}`, 422, 'asset_failed');
      if (!['NONE', 'UPLOADING', 'PROCESSING', 'EXPIRED'].includes(asset.status)) throw fail(`未知素材状态：${asset.status}`, 502, 'invalid_asset');
      if (Date.now() >= deadline) throw fail(`素材 ${id} 审核等待超时`, 504, 'asset_timeout');
      await sleep(interval, undefined, { signal });
      asset = await call('/asset/seedance2/assetDetail', { assetId: id });
    }
  }
  for (const [key, kind] of [['reference_images', 'Image'], ['reference_videos', 'Video'], ['reference_audios', 'Audio']]) {
    for (let i = 0; i < (body[key]?.length || 0); i++) await prepare(body[key][i], kind, value => { body[key][i] = value; });
  }
  for (const key of ['first_image', 'last_image']) if (body[key]) await prepare(body[key], 'Image', value => { body[key] = value; });
}

export function applyStatus(job, upstream) {
  const statuses = { queued: 'queued', pending: 'queued', processing: 'running', running: 'running', in_progress: 'running', completed: 'succeeded', failed: 'failed', canceled: 'cancelled', cancelled: 'cancelled', expired: 'expired' };
  if (!Object.hasOwn(statuses, upstream.status)) throw fail(`未知上游任务状态：${upstream.status}`, 502, 'upstream_invalid_response');
  const status = statuses[upstream.status];
  if (status === 'succeeded') {
    const url = upstream.video_url || upstream.result_url;
    if (!url) throw fail('上游任务完成但没有视频地址', 502, 'upstream_invalid_response');
    job.video_url = httpUrl(url);
    if (Number.isFinite(upstream.actualDuration) && upstream.actualDuration > 0) job.duration = upstream.actualDuration;
    const tokens = upstream.usage?.total_tokens ?? upstream['usage.total_tokens'];
    if (Number.isSafeInteger(tokens) && tokens >= 0) job.usage = { completion_tokens: tokens, total_tokens: tokens };
  }
  if (['failed','expired'].includes(status)) job.error = { code: status === 'expired' ? 'task_expired' : 'generation_failed', message: String(upstream.error?.message || upstream.error_message || upstream.error || '上游视频生成失败或超时').slice(0, 1000) };
  job.status = status;
}

export function taskObject(job) {
  return {
    id: job.id, model: job.model, status: job.status,
    created_at: job.created_at, updated_at: job.updated_at ?? job.created_at,
    content: job.status === 'succeeded' ? { video_url: job.video_url } : {},
    duration: job.duration ?? job.body.duration, ratio: job.body.aspect_ratio, resolution: job.body.resolution,
    generate_audio: job.body.generate_audio ?? true, error: job.error || null,
    ...(job.body.seed !== undefined ? { seed: job.body.seed } : {}),
    ...(job.usage ? { usage: job.usage } : {}),
  };
}
