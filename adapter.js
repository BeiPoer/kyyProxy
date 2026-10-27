import { setTimeout as sleep } from 'node:timers/promises';

export const models = ['sd_2.0_special', 'sd_2.0_fast_special', 'sd_2.0_mini_special', 'sd_2.0_discount', 'sd_2.0_fast_discount', 'sd_2.0_mini_discount'];
export function fail(message, status = 400, code = 'invalid_request_error') {
  return Object.assign(new Error(message), { status, code });
}
export function httpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('素材必须是 HTTP(S) URL 或 assetId://ID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('不支持的素材 URL');
  return url.href;
}
function reference(value) {
  if (typeof value !== 'string') throw fail('素材引用必须是字符串');
  return /^assetId:\/\/[\w-]+$/.test(value) ? value : httpUrl(value);
}

// shortcut: 1024/1792 sizes map to a nearby upstream tier; add transcoding only if exact pixels are required.
const sizes = {
  '720x1280': ['9:16', '720p'], '1280x720': ['16:9', '720p'],
  '1024x1792': ['9:16', '1080p'], '1792x1024': ['16:9', '1080p'],
  '1080x1920': ['9:16', '1080p'], '1920x1080': ['16:9', '1080p'],
  '720x720': ['1:1', '720p'], '1080x1080': ['1:1', '1080p'],
};
export function mapRequest(input, defaultModel) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('请求体必须是对象');
  const allowed = new Set(['model', 'prompt', 'seconds', 'size', 'input_reference', 'reference_images', 'reference_videos', 'reference_audios', 'first_image', 'last_image', 'generate_audio', 'watermark', 'seed']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw fail(`不支持参数 ${key}`);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw fail('prompt 必须是 1–32000 字符的文本');
  const model = input.model ?? defaultModel;
  if (typeof model !== 'string' || ![...models, 'sora-2', 'sora-2-pro'].includes(model)) throw fail('不支持的 model，请查询 /v1/models');
  const seconds = input.seconds ?? '4';
  if (!['string', 'number'].includes(typeof seconds) || !/^\d+$/.test(String(seconds)) || Number(seconds) < 4 || Number(seconds) > 15) throw fail('seconds 必须是 4–15 的整数');
  const size = input.size ?? '720x1280';
  if (typeof size !== 'string' || !Object.hasOwn(sizes, size)) throw fail(`不支持的 size，可用值：${Object.keys(sizes).join(', ')}`);
  const [aspect_ratio, resolution] = sizes[size];
  const body = { model: model.startsWith('sora-') ? defaultModel : model, prompt: input.prompt.trim(), duration: Number(seconds), aspect_ratio, resolution };
  for (const name of ['generate_audio', 'watermark']) {
    if (input[name] !== undefined) {
      if (typeof input[name] !== 'boolean') throw fail(`${name} 必须是布尔值`);
      body[name] = input[name];
    }
  }
  if (input.seed !== undefined) {
    if (!Number.isSafeInteger(input.seed) || input.seed < -1) throw fail('seed 必须是大于等于 -1 的安全整数');
    body.seed = input.seed;
  }
  for (const [key, max] of [['reference_images', 9], ['reference_videos', 3], ['reference_audios', 3]]) {
    if (input[key] !== undefined) {
      if (!Array.isArray(input[key]) || input[key].length > max) throw fail(`${key} 最多 ${max} 个素材`);
      if (input[key].length) body[key] = input[key].map(reference);
    }
  }
  for (const key of ['first_image', 'last_image']) if (input[key] !== undefined) body[key] = reference(input[key]);
  if (input.input_reference !== undefined) {
    if (body.first_image || body.last_image || body.reference_images || body.reference_videos || body.reference_audios) throw fail('input_reference 不能与扩展素材字段混用');
    const ref = input.input_reference;
    if (typeof ref === 'object' && ref !== null && !Array.isArray(ref)) {
      if (Object.keys(ref).length !== 1 || !Object.hasOwn(ref, 'image_url')) throw fail('input_reference 仅支持 image_url，不支持 OpenAI file_id');
      body.first_image = reference(ref.image_url);
    } else body.first_image = reference(ref);
  }
  if ((body.first_image || body.last_image) && (body.reference_images || body.reference_videos || body.reference_audios)) throw fail('首尾帧不能与多模态参考素材混用');
  if (body.last_image && !body.first_image) throw fail('last_image 需要 first_image');
  if (body.reference_audios && !body.reference_images && !body.reference_videos) throw fail('音频参考需要同时提供图片或视频');
  return { body, model, size, seconds: String(Number(seconds)) };
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
  const status = { queued: 'queued', pending: 'queued', processing: 'in_progress', running: 'in_progress', in_progress: 'in_progress', completed: 'completed', failed: 'failed', canceled: 'failed', cancelled: 'failed', expired: 'failed' }[upstream.status];
  if (!status) throw fail(`未知上游任务状态：${upstream.status}`, 502, 'upstream_invalid_response');
  job.status = status;
  if (Number.isFinite(upstream.progress)) job.progress = Math.max(0, Math.min(100, upstream.progress));
  if (status === 'completed') {
    const url = upstream.video_url || upstream.result_url;
    if (!url) throw fail('上游任务完成但没有视频地址', 502, 'upstream_invalid_response');
    job.video_url = httpUrl(url);
    job.progress = 100;
    job.completed_at ||= Math.floor(Date.now() / 1000);
  }
  if (status === 'failed') job.error = { code: 'generation_failed', message: String(upstream.error?.message || upstream.error_message || upstream.error || '上游视频生成失败').slice(0, 1000) };
}

export function videoObject(job) {
  return {
    id: job.id, object: 'video', model: job.model, status: job.status, progress: job.progress,
    created_at: job.created_at, completed_at: job.completed_at || null, expires_at: null,
    prompt: job.body.prompt, seconds: job.seconds, size: job.size, error: job.error || null,
    remixed_from_video_id: null, ...(job.video_url ? { video_url: job.video_url } : {}),
    ...(job.remoteId ? { upstream_id: job.remoteId } : {}),
  };
}
