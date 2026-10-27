import https from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './adapter.js';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',3]]) blocked.addSubnet(ip, bits);
export function publicAddress(address) {
  return isIP(address) === 4 ? !blocked.check(address) : isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^200[12]:/i.test(address);
}
const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const assetPattern = /^(\d{13})-[a-f0-9]{48}\.(png|jpg|webp)$/;

export async function saveImage(value, config) {
  if (!config.publicBase) throw fail('上传文件或 Base64 图片需要配置 PUBLIC_BASE_URL 为代理的公网 HTTPS 地址');
  let bytes, mime;
  if (typeof value === 'string') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) throw fail('仅支持 PNG、JPEG、WebP Base64 图片');
    mime = match[1]; bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) throw fail('Base64 编码无效');
  } else { mime = value.type; bytes = Buffer.from(await value.arrayBuffer()); }
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

export async function downloadVideo(source, redirects = 0) {
  let url;
  try { url = new URL(source); } catch { throw fail('视频地址无效', 502); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (isIP(host) && !publicAddress(host))) throw fail('视频下载仅允许公网 HTTPS 地址', 502);
  const response = await new Promise((resolve, reject) => {
    // Pin validated DNS answers to this connection, including every redirect.
    const request = https.get(url, { signal: AbortSignal.timeout(180000), lookup(hostname, options, callback) {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error || !addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(fail('视频地址无法解析为公网地址', 502));
        if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
      });
    } }, resolve);
    request.on('error', () => reject(fail('视频下载连接失败或超时', 502)));
  });
  if ([301,302,303,307,308].includes(response.statusCode)) {
    const location = response.headers.location; response.destroy();
    if (!location || redirects >= 3) throw fail('视频下载重定向无效或过多', 502);
    return downloadVideo(new URL(location, url).href, redirects + 1);
  }
  const mime = response.headers['content-type']?.split(';')[0];
  if (response.statusCode !== 200 || (mime && !['video/mp4','application/octet-stream','binary/octet-stream'].includes(mime)) || Number(response.headers['content-length']) > 512 * 1024 * 1024) {
    response.destroy(); throw fail('视频下载失败、格式错误或超过 512 MiB', 502);
  }
  return response;
}
