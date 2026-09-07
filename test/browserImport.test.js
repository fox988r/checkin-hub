import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-import-'));
process.env.APP_SECRET = 'test-secret-for-browser-import';

const upstream = new Map(Object.entries({
  '/api/status': { status: 200, body: { success: true, data: { system_name: '糖糕站', version: 'v1.2.3', quota_per_unit: 500000, quota_display_type: 'USD' } } },
  '/api/user/self': { status: 200, body: { success: true, data: { id: 42, username: 'tanggao', quota: 1625000, used_quota: 0 } } },
  '/api/user/checkin': { status: 404, body: { message: 'Not Found' } }
}));

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  const hit = upstream.get(path) || { status: 404, body: { message: 'Not Found' } };
  return { ok: hit.status < 400, status: hit.status, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(hit.body) };
};

const { installImportRoutes, rotateImportToken, revokeImportToken } = await import('../src/browserImport.js');
const { readStore } = await import('../src/store.js');

const app = express();
app.use(express.json());
installImportRoutes(app, (_req, _res, next) => next());
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const callApi = async (apiPath, options = {}) => {
  const response = await realFetch(`${base}${apiPath}`, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let token = rotateImportToken();
after(() => server.close());
const credential = 'session=MTc0NjcxNTIyNnx6ExampleCookieValueDoNotLog';
const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const goodPayload = { name: '糖糕站', baseUrl: 'https://example.com', panelType: 'newapi', userId: '42', credential };

test('import rejects missing and invalid tokens', async () => {
  const missing = await callApi('/api/import/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(goodPayload) });
  assert.equal(missing.status, 401);
  const wrong = await callApi('/api/import/account', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sphimp_wrong' }, body: JSON.stringify(goodPayload) });
  assert.equal(wrong.status, 401);
});

test('creates a verified browser-import account without storing secrets in plaintext', async () => {
  const response = await callApi('/api/import/account', { method: 'POST', headers: authHeaders, body: JSON.stringify(goodPayload) });
  assert.equal(response.status, 200);
  assert.equal(response.body.result, 'created');
  assert.equal(response.body.verification.balance, '$3.25');
  const account = readStore().accounts.find(x => x.baseUrl === 'https://example.com');
  assert.ok(account);
  assert.equal(account.source, 'browser-import');
  assert.notEqual(account.credential, credential);
  assert.match(account.credential, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(account.apiKey, '');
  assert.equal(account.refreshCookie, '');
  assert.equal(account.pricingCookie, '');
  assert.equal(account.balance, '$3.25');
  assert.equal(account.userId, '42');
  assert.equal(account.lastStatus, 'ok');
  // GET 探测返回 404：签到接口应标记为“未确认”，绝不 POST 触发签到
  assert.equal(account.checkinSupported, null);
});

test('ignores fields the browser is not allowed to set', async () => {
  await callApi('/api/import/account', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      ...goodPayload,
      id: 'forged-id',
      apiKey: 'sk-forbidden',
      refreshCookie: 'new_api_refresh=forbidden',
      pricingCookie: 'session=forbidden',
      balancePath: '/etc/passwd',
      inviteUrl: 'https://evil.example',
      enabled: false,
      refreshMode: 'browser',
      secretField: 'nope'
    })
  });
  const account = readStore().accounts.find(x => x.baseUrl === 'https://example.com');
  assert.equal(account.apiKey, '');
  assert.equal(account.refreshCookie, '');
  assert.equal(account.pricingCookie, '');
  assert.equal(account.balancePath, '');
  assert.equal(account.inviteUrl, '');
  assert.equal(account.enabled, true);
  assert.equal(account.refreshMode, 'http');
  assert.equal(account.id, 'forged-id' ? account.id : account.id);
  assert.notEqual(account.id, 'forged-id');
});

test('re-importing the same baseUrl updates instead of duplicating', async () => {
  const before = readStore().accounts.length;
  const response = await callApi('/api/import/account', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ ...goodPayload, name: '糖糕站改名', credential: 'session=rotated-cookie-value' })
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.result, 'updated');
  assert.equal(response.body.existed, true);
  const matches = readStore().accounts.filter(x => x.baseUrl === 'https://example.com');
  assert.equal(matches.length, 1);
  assert.equal(readStore().accounts.length, before);
  assert.equal(matches[0].name, '糖糕站改名');
  assert.equal(matches[0].source, 'browser-import');
});

test('failed verification saves nothing and keeps the existing credential', async () => {
  const account = readStore().accounts.find(x => x.baseUrl === 'https://example.com');
  const previousCredential = account.credential;
  const previousCount = readStore().accounts.length;
  upstream.set('/api/user/self', { status: 401, body: { success: false, message: '无权进行此操作，未登录' } });
  try {
    const response = await callApi('/api/import/account', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ ...goodPayload, credential: 'session=expired-or-invalid-cookie' })
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /登录验证失败/);
    assert.equal(readStore().accounts.length, previousCount);
    assert.equal(readStore().accounts.find(x => x.baseUrl === 'https://example.com').credential, previousCredential);
    const serialized = JSON.stringify(response.body) + JSON.stringify(readStore().importRecords);
    assert.ok(!serialized.includes('expired-or-invalid-cookie'));
  } finally {
    upstream.set('/api/user/self', { status: 200, body: { success: true, data: { id: 42, username: 'tanggao', quota: 1625000, used_quota: 0 } } });
  }
});

test('newapi imports without a numeric user id are rejected', async () => {
  const response = await callApi('/api/import/account', { method: 'POST', headers: authHeaders, body: JSON.stringify({ ...goodPayload, userId: 'abc' }) });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /用户 ID/);
});

test('import refuses plaintext http targets in production mode', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const response = await callApi('/api/import/account', { method: 'POST', headers: authHeaders, body: JSON.stringify({ ...goodPayload, baseUrl: 'http://example.com' }) });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /HTTPS|内网|无效/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test('import refuses loopback targets even over https', async () => {
  const response = await callApi('/api/import/account', { method: 'POST', headers: authHeaders, body: JSON.stringify({ ...goodPayload, baseUrl: 'https://127.0.0.1' }) });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /内网/);
});

test('check endpoint reports existing sites without exposing credentials', async () => {
  const response = await callApi(`/api/import/check?baseUrl=${encodeURIComponent('https://example.com')}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.body.exists, true);
  assert.ok(!JSON.stringify(response.body).includes(credential));
});

test('revoked tokens stop working immediately', async () => {
  revokeImportToken();
  const response = await callApi('/api/import/check', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 401);
  const previous = token;
  token = rotateImportToken();
  authHeaders.authorization = `Bearer ${token}`;
  const ok = await callApi('/api/import/check', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  const old = await callApi('/api/import/check', { headers: { authorization: `Bearer ${previous}` } });
  assert.equal(old.status, 401);
});

test('manual accounts created through the admin API keep working alongside imports', async () => {
  const { mutateStore } = await import('../src/store.js');
  mutateStore(db => {
    db.accounts.push({
      id: 'manual-1', name: '手动站', baseUrl: 'https://manual.example.com', panelType: 'newapi',
      userId: '7', credential: 'encrypted-manual', apiKey: '', refreshCookie: '', pricingCookie: '',
      tags: ['常用'], enabled: true
    });
  });
  const manual = readStore().accounts.find(x => x.id === 'manual-1');
  assert.equal(manual.source, undefined, '手动账号不带 browser-import 来源标记');
  assert.equal(manual.credential, 'encrypted-manual');
  const response = await callApi(`/api/import/check?baseUrl=${encodeURIComponent('https://example.com')}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.body.name, '糖糕站改名');
});

test('confirmed checkin support auto-joins the check-in queue with the tag', async () => {
  upstream.set('/api/user/checkin', { status: 200, body: { success: true, message: '签到成功' } });
  const response = await callApi('/api/import/account', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ ...goodPayload, baseUrl: 'https://example.org', name: '可签到站' })
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.autoTagged, true);
  assert.equal(response.body.account.adapterId, 'new-api');
  const db = readStore();
  assert.ok(db.tags.includes('自动签到'), '标签应被自动创建');
  assert.ok(db.pollTags.includes('自动签到'), '标签应默认参与轮询');
  assert.ok(db.accounts.find(x => x.baseUrl === 'https://example.org').tags.includes('自动签到'));
});

test('unconfirmed checkin support never auto-joins the check-in queue', async () => {
  upstream.set('/api/user/checkin', { status: 404, body: { message: 'Not Found' } });
  const response = await callApi('/api/import/account', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ ...goodPayload, baseUrl: 'https://www.example.com', name: '待确认站' })
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.autoTagged, false);
  const account = readStore().accounts.find(x => x.baseUrl === 'https://www.example.com');
  assert.equal(account.tags.includes('自动签到'), false);
  assert.equal(account.checkinSupported, null);
});

test('the auto check-in queue toggle can be turned off and respected', async () => {
  const off = await realFetch(`${base}/api/import/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  upstream.set('/api/user/checkin', { status: 200, body: { success: true, message: '签到成功' } });
  const response = await callApi('/api/import/account', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ ...goodPayload, baseUrl: 'https://www.example.org', name: '关掉自动签到的站' })
  });
  assert.equal(response.body.autoTagged, false);
  assert.equal(readStore().accounts.find(x => x.baseUrl === 'https://www.example.org').tags.includes('自动签到'), false);
  const settings = await realFetch(`${base}/api/import/settings`);
  assert.equal((await settings.json()).autoCheckinOnImport, false);
});

test('imports record the resolved adapter on the account', () => {
  const legacy = readStore().accounts.find(x => x.baseUrl === 'https://example.com');
  assert.equal(legacy.adapterId, 'new-api');
  assert.equal(legacy.source, 'browser-import');
});
