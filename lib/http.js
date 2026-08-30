/** HTTP 工具：请求体读取、JSON 响应、Cookie、静态文件、安全响应头、gzip 压缩 */
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createGzip, gzipSync } from 'node:zlib';
import { config } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 可压缩的扩展名。图片/字体本身已是压缩格式，再压一遍只浪费 CPU。
 * 实测：前端 315 KB 的 JS/CSS/HTML 压到 80 KB，单模块 200 条的 JSON 从 66 KB 压到 3.3 KB。
 * 在小带宽（1 Mbps）现场，这是唯一能同时改善首屏与每次数据加载的手段。
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);

/** 小于这个大小不压缩：gzip 头本身有开销，反而变大 */
const COMPRESS_MIN_BYTES = 1024;

/**
 * 一次性协商本请求的响应编码，结果挂在 res 上供后续 send* 使用。
 * 放在请求入口统一做，避免每个 send* 都要能拿到 req。
 */
export function negotiateEncoding(req, res) {
  const raw = String(req.headers['accept-encoding'] || '');
  res._finGzip = config.compress && /\bgzip\b/i.test(raw);
  return res._finGzip;
}

function wantsGzip(res, byteLength, ext) {
  if (!res._finGzip) return false;
  if (byteLength < COMPRESS_MIN_BYTES) return false;
  if (ext !== undefined && !COMPRESSIBLE.has(ext)) return false;
  return true;
}

export function securityHeaders(res, { html = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (html) {
    // 页面自身不加载任何第三方资源；'unsafe-inline' 是为了兼容页面里的内联 <style>
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    );
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  let body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  securityHeaders(res);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...extraHeaders,
  };
  if (wantsGzip(res, body.length)) {
    body = gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  let body = Buffer.from(String(text), 'utf8');
  securityHeaders(res);
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (wantsGzip(res, body.length)) {
    body = gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export function sendAttachment(res, filename, payload) {
  let body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8');
  securityHeaders(res);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (wantsGzip(res, body.length)) {
    body = gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
}

/**
 * 安全的 URI 解码：非法百分号编码返回 null 而不是抛异常。
 * 曾经的问题：一个坏 Cookie（如 fin_sid=%）会让每一个请求（含首页）都 500，
 * 用户完全无法访问系统且无法自行恢复——浏览器会一直把这个坏 Cookie 发回来。
 */
export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    // 单个 Cookie 解码失败只丢弃这一个，不影响其他 Cookie，也不让整个请求失败
    const v = safeDecode(part.slice(i + 1).trim());
    if (v !== null) out[k] = v;
  }
  return out;
}

export function cookieHeader(name, value, { maxAgeSeconds, expires } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (config.cookieSecure) bits.push('Secure');
  if (maxAgeSeconds !== undefined) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (expires) bits.push(`Expires=${new Date(expires).toUTCString()}`);
  return bits.join('; ');
}

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim().slice(0, 64);
  }
  return String(req.socket?.remoteAddress || '').slice(0, 64);
}

/** 判断跨站写请求：同源策略的兜底（配合 SameSite=Strict 双保险） */
export function sameOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器发起或同源导航
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 静态文件：路径穿越防护 + 目录索引到 index.html + gzip。
 * 返回 true 表示已经响应（含 400/403），false 表示未命中交给调用方兜底。
 */
export function serveStatic(req, res, urlPath) {
  const rootDir = resolve(config.publicDir);
  const decoded = safeDecode(urlPath.split('?')[0]);
  if (decoded === null) {
    sendText(res, 400, '请求路径编码非法');
    return true;
  }
  let rel = decoded;
  if (rel.endsWith('/')) rel += 'index.html';
  const target = resolve(rootDir, `.${normalize(rel).replace(/^([/\\])+/, sep)}`);
  if (target !== rootDir && !target.startsWith(rootDir + sep)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    return false;
  }
  if (st.isDirectory()) return serveStatic(req, res, `${rel.replace(/\/$/, '')}/index.html`);

  const ext = extname(target).toLowerCase();
  const isHtml = ext === '.html';
  const gzip = wantsGzip(res, st.size, ext);
  // ETag 要区分编码，否则中间代理可能把压缩体回给不支持压缩的客户端
  const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}${gzip ? '-gz' : ''}"`;
  if (req.headers['if-none-match'] === etag) {
    securityHeaders(res, { html: isHtml });
    res.writeHead(304, { ETag: etag, Vary: 'Accept-Encoding' });
    res.end();
    return true;
  }
  securityHeaders(res, { html: isHtml });
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    Vary: 'Accept-Encoding',
    // HTML 不缓存，保证部署新版本后刷新即生效；静态资源短缓存 + ETag 校验。
    // 这里刻意不用长 max-age + immutable：文件名不带内容哈希，长缓存会让用户在部署后
    // 拿到旧版前端。内网 RTT 只有几毫秒，304 协商的成本可以忽略，正确性更值钱。
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300, must-revalidate',
  };
  if (gzip) {
    // 压缩后长度未知，改用分块传输
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    const gz = createGzip({ level: 6 });
    gz.on('error', () => res.destroy());
    const rs = createReadStream(target);
    rs.on('error', () => res.destroy());
    rs.pipe(gz).pipe(res);
    return true;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  const rs = createReadStream(target);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
  return true;
}

export function indexFile() {
  return join(config.publicDir, 'index.html');
}
