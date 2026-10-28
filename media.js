import { randomBytes } from 'node:crypto';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './adapter.js';

const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const assetPattern = /^(\d{13})-[a-f0-9]{48}\.(png|jpg|webp)$/;

export async function saveImage(value, config) {
  if (!config.publicBase) throw fail('Base64 图片需要配置 PUBLIC_BASE_URL 为代理的公网 HTTPS 地址');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw fail('仅支持 PNG、JPEG、WebP Base64 图片');
  const mime = match[1], bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) throw fail('Base64 编码无效');
  if (!mimeExtensions[mime] || bytes.length === 0 || bytes.length > 30 * 1024 * 1024) throw fail('图片仅支持 PNG、JPEG、WebP，大小须为 1 字节至 30 MiB');
  const valid = mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!valid) throw fail('图片内容与声明格式不匹配');
  const name = `${Date.now() + 86400000}-${randomBytes(24).toString('hex')}.${mimeExtensions[mime]}`;
  await writeFile(join(config.dataDir, 'assets', name), bytes, { flag: 'wx', mode: 0o600 });
  return config.publicBase + '/assets/' + name;
}

export async function serveImage(name, config, res, head = false) {
  const match = assetPattern.exec(name);
  if (!match || Number(match[1]) <= Date.now()) throw fail('素材不存在或已过期', 404, 'not_found');
  let bytes;
  try { bytes = await readFile(join(config.dataDir, 'assets', name)); }
  catch (error) { if (error.code === 'ENOENT') throw fail('素材不存在', 404, 'not_found'); throw error; }
  res.writeHead(200, { 'content-type': { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[match[2]], 'content-length': bytes.length, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : bytes);
}

export async function cleanAssets(config) {
  for (const name of await readdir(join(config.dataDir, 'assets'))) {
    const match = assetPattern.exec(name);
    if (match && Number(match[1]) <= Date.now()) await rm(join(config.dataDir, 'assets', name), { force: true });
  }
}
