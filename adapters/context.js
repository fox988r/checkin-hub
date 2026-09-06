import { decrypt, encrypt } from '../src/store.js';
import { safeUrl } from '../src/runner.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Adapter 统一上下文：所有远端请求必须经过这里，内部强制 safeUrl()
// （HTTPS 限制 + SSRF 防护 + 超时 + redirect 限制）。dryRun 时任何
// 非只读方法都会被直接拦截，保证扫描/探测路径不可能产生写请求。
export function createAdapterContext(account, { dryRun = false, storageHints = null, now = new Date() } = {}) {
  const context = {
    baseUrl: account.baseUrl,
    userId: account.userId || '',
    credential: decrypt(account.credential || ''),
    authType: account.authType || 'cookie',
    headerName: account.headerName || '',
    dryRun: Boolean(dryRun),
    storageHints,
    now,
    extraHeaders: {}
  };

  async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (!READ_METHODS.has(method) && context.dryRun) {
      throw new Error(`dry-run：已拦截写请求 ${method} ${path}`);
    }
    const url = await safeUrl(context.baseUrl, path);
    const headers = {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5) AppleWebKit/537.36 Chrome/136.0.0.0 Mobile Safari/537.36',
      referer: `${context.baseUrl}/`,
      ...context.extraHeaders,
      ...options.headers
    };
    if (options.auth !== false) {
      if (context.authType === 'bearer') headers.authorization = `Bearer ${context.credential}`;
      else if (context.authType === 'cookie') headers.cookie = context.credential;
      else if (context.authType === 'header') headers[context.headerName || 'authorization'] = context.credential;
    }
    const response = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, data, text, contentType: response.headers.get('content-type') || '' };
  }

  context.fetchJson = request;
  context.fetchText = request;
  return context;
}

export function encryptCredential(value) {
  return encrypt(value || '');
}
