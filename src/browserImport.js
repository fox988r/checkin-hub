import crypto from 'node:crypto';
import { decrypt, encrypt, mutateStore, readStore } from './store.js';
import { call, formatQuota, readRemainingQuota, safeUrl } from './runner.js';

const TOKEN_PREFIX = 'sphimp_';
const MAX_IMPORT_RECORDS = 30;

const importRateBuckets = new Map();
let importChain = Promise.resolve();

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufferA = Buffer.from(String(a || ''), 'hex');
  const bufferB = Buffer.from(String(b || ''), 'hex');
  return bufferA.length === bufferB.length && bufferA.length > 0 && crypto.timingSafeEqual(bufferA, bufferB);
}

export function validImportToken(token, hash) {
  if (!token || !hash) return false;
  const value = String(token);
  return value.startsWith(TOKEN_PREFIX) && timingSafeEqualHex(hashToken(value), hash);
}

export function rotateImportToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return mutateStore(db => {
    db.importToken = { hash: hashToken(token), createdAt: new Date().toISOString(), lastUsedAt: null };
    if (!Array.isArray(db.importRecords)) db.importRecords = [];
    return token;
  });
}

export function revokeImportToken() {
  mutateStore(db => { delete db.importToken; });
}

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 10 * 60000;
  const hits = (importRateBuckets.get(ip) || []).filter(time => time > windowStart);
  hits.push(now);
  importRateBuckets.set(ip, hits);
  if (importRateBuckets.size > 500) {
    for (const [key, times] of importRateBuckets) if (!times.some(time => time > windowStart)) importRateBuckets.delete(key);
  }
  return hits.length > 30;
}

// 只做无副作用探测：绝不用 POST 触发签到。GET 404 在部分框架下无法区分
// “路由不存在”和“方法不允许”，所以返回 true（确认支持）/ null（未确认）。
async function probeCheckinEndpoint(account) {
  try {
    const url = await safeUrl(account.baseUrl, '/api/user/checkin');
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/plain, */*', cookie: decrypt(account.credential), 'new-api-user': String(account.userId || ''), referer: `${account.baseUrl}/` },
      redirect: 'manual', signal: AbortSignal.timeout(15000)
    });
    await response.text().catch(() => '');
    if (response.ok || [401, 403, 405].includes(response.status)) return true;
    return null;
  } catch {
    return null;
  }
}

export async function verifyImportedAccount(account) {
  let statusData = {};
  try { statusData = await call(account, '/api/status', 'GET', 'public'); } catch {}
  const self = await call(account, '/api/user/self', 'GET', 'newapi');
  if (self?.success === false) throw new Error(self?.message || '站点返回登录失败');
  const rawBalance = readRemainingQuota(self);
  if (rawBalance === undefined) throw new Error(self?.message || '登录验证失败：余额响应中没有 data.quota');
  const statusHint = JSON.stringify(statusData).match(/"(checkin[_-]?enabled|checkinEnabled|sign[_-]?in[_-]?enabled)"\s*:\s*(true|1)/i);
  const checkinSupported = statusHint ? true : await probeCheckinEndpoint(account);
  return {
    balance: formatQuota(rawBalance, statusData, account.currency || 'auto'),
    rawBalance,
    quotaPerUnitValue: statusData,
    checkinSupported
  };
}

function sanitizedTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，]/);
  return [...new Set(list.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 10).map(tag => tag.slice(0, 30));
}

export function buildImportPayload(body = {}) {
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    baseUrl,
    panelType: body.panelType === 'generic' ? 'generic' : 'newapi',
    userId: String(body.userId || '').replace(/\D/g, '').slice(0, 20),
    credential: String(body.credential || '').replace(/^Cookie:\s*/i, '').trim().slice(0, 8192),
    name: String(body.name || '').trim().slice(0, 60),
    tags: sanitizedTags(body.tags)
  };
}

function recordImport(name, baseUrl, result, message = '') {
  mutateStore(db => {
    if (!Array.isArray(db.importRecords)) db.importRecords = [];
    let origin = baseUrl;
    try { origin = new URL(baseUrl).origin; } catch {}
    db.importRecords.unshift({ at: new Date().toISOString(), name, origin, result, message: String(message).slice(0, 200), source: 'browser-import' });
    db.importRecords = db.importRecords.slice(0, MAX_IMPORT_RECORDS);
  });
}

export function installImportRoutes(app, adminAuth) {
  app.use('/api/import', (req, res, next) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/api/import/token', adminAuth, (_req, res) => {
    const token = readStore().importToken;
    res.json({ active: Boolean(token), createdAt: token?.createdAt || null, lastUsedAt: token?.lastUsedAt || null });
  });
  app.post('/api/import/token', adminAuth, (_req, res) => res.json({ ok: true, token: rotateImportToken() }));
  app.delete('/api/import/token', adminAuth, (_req, res) => { revokeImportToken(); res.json({ ok: true }); });
  app.get('/api/import/records', adminAuth, (_req, res) => res.json({ records: readStore().importRecords || [] }));

  function importAuth(req, res, next) {
    if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!validImportToken(token, readStore().importToken?.hash)) return res.status(401).json({ error: '导入 Token 无效或已吊销' });
    next();
  }

  app.get('/api/import/check', importAuth, (req, res) => {
    const baseUrl = String(req.query.baseUrl || '').trim().replace(/\/+$/, '');
    const account = readStore().accounts.find(x => x.baseUrl === baseUrl);
    res.json({ exists: Boolean(account), name: account?.name || null });
  });

  app.post('/api/import/account', importAuth, async (req, res) => {
    const payload = buildImportPayload(req.body);
    if (!payload.baseUrl) return res.status(400).json({ error: '缺少站点地址' });
    try {
      const parsed = new URL(payload.baseUrl);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.pathname !== '/') return res.status(400).json({ error: '站点地址必须是根地址，例如 https://api.example.com' });
      await safeUrl(payload.baseUrl, '/');
    } catch (error) {
      return res.status(400).json({ error: `站点地址无效：${error.message}` });
    }
    if (!payload.credential) return res.status(400).json({ error: '缺少登录凭据' });
    if (payload.panelType === 'newapi' && !payload.userId) return res.status(400).json({ error: '缺少用户 ID：请在扩展中补填数字用户 ID' });

    const probe = {
      baseUrl: payload.baseUrl, panelType: payload.panelType, userId: payload.userId,
      authType: 'cookie', headerName: '', refreshMode: 'http', currency: 'auto',
      credential: encrypt(payload.credential)
    };
    let verification;
    try {
      verification = await verifyImportedAccount(probe);
    } catch (error) {
      recordImport(payload.name || payload.baseUrl, payload.baseUrl, 'failed', error.message);
      return res.status(400).json({ error: `登录验证失败，未保存：${error.message}` });
    }

    const outcome = await new Promise(resolve => {
      importChain = importChain.catch(() => {}).then(() => {
        try {
          resolve(mutateStore(db => {
            const now = new Date().toISOString();
            const old = db.accounts.find(x => x.baseUrl === payload.baseUrl);
            if (old?.panelType === 'generic') return { result: 'conflict', message: '该地址已存在自定义 JSON API 站点，未覆盖' };
            const shared = {
              name: payload.name || old?.name || payload.baseUrl.replace(/^https?:\/\//, ''),
              userId: payload.userId || old?.userId || '',
              credential: encrypt(payload.credential),
              tags: [...new Set([...(old?.tags || []), ...payload.tags])].slice(0, 10),
              source: 'browser-import',
              checkinSupported: verification.checkinSupported,
              balance: verification.balance,
              balanceRaw: verification.rawBalance,
              lastStatus: 'ok', lastError: '', lastCheckedAt: now
            };
            let account;
            if (old) {
              account = { ...old, ...shared, quotaPerUnit: old.quotaPerUnit, updatedAt: now };
              db.accounts[db.accounts.indexOf(old)] = account;
            } else {
              account = {
                id: crypto.randomUUID(), baseUrl: payload.baseUrl,
                inviteUrl: '', modelBaseUrl: '', panelType: payload.panelType, currency: 'auto',
                modelName: '', balancePath: '', balanceField: 'balance', balanceDivisor: '1',
                checkinPath: '', checkinMethod: 'POST', authType: 'cookie', headerName: '',
                refreshPath: '', refreshMode: 'http', enabled: true,
                credential: shared.credential, refreshCookie: '', pricingCookie: '', apiKey: '',
                ...shared, updatedAt: now, createdAt: now
              };
              db.accounts.push(account);
            }
            db.runs.unshift({ id: crypto.randomUUID(), accountId: account.id, action: 'poll', status: 'ok', message: old ? '浏览器导入：更新登录态并验证成功' : '浏览器导入：验证成功', startedAt: now });
            db.runs = db.runs.slice(0, 5000);
            return { result: old ? 'updated' : 'created', account };
          }));
        } catch (error) {
          resolve({ error: error.message });
        }
      });
    });
    if (outcome.error) return res.status(400).json({ error: outcome.error });

    recordImport(outcome.account.name, payload.baseUrl, outcome.result, verification.balance);
    mutateStore(db => { if (db.importToken) db.importToken.lastUsedAt = new Date().toISOString(); });
    res.json({
      ok: true,
      result: outcome.result,
      existed: outcome.result !== 'created',
      verification: { balance: verification.balance, checkinSupported: verification.checkinSupported },
      account: { id: outcome.account.id, name: outcome.account.name }
    });
  });
}
