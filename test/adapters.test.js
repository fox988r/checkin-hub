import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-adapters-'));
process.env.APP_SECRET = 'test-secret-for-adapters';

const upstream = new Map(Object.entries({
  '/api/status': { status: 200, body: { success: true, data: { system_name: '糖糕站', version: 'v1', quota_per_unit: 500000 } } },
  '/api/user/self': { status: 200, body: { success: true, data: { id: 42, username: 'tanggao', quota: 1000000, used_quota: 0 } } },
  '/api/user/checkin': { status: 200, body: { success: true, message: '签到成功' } },
  '/api/user': { status: 200, body: { data: { points: 120 } } },
  '/api/checkin': { status: 200, body: { success: true, message: '签到成功' } }
}));

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const pathname = new URL(String(input instanceof Request ? input.url : input)).pathname;
  const hit = upstream.get(pathname) || { status: 404, body: { message: 'Not Found' } };
  return { ok: hit.status < 400, status: hit.status, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(hit.body) };
};

const { runAccount } = await import('../src/runner.js');
const { mutateStore } = await import('../src/store.js');
const { encrypt } = await import('../src/store.js');
const newApi = (await import('../adapters/new-api.js')).default;
const genericJson = (await import('../adapters/generic-json.js')).default;
const { createAdapterContext } = await import('../adapters/context.js');

mutateStore(db => {
  db.accounts.push(
    { id: 'legacy-newapi', name: '旧版 New API 账号', baseUrl: 'https://example.com', panelType: 'newapi', userId: '42', credential: encrypt('session=legacy-cookie'), tags: ['常用'], enabled: true },
    { id: 'legacy-generic', name: '旧版自定义账号', baseUrl: 'https://example.com', panelType: 'generic', authType: 'cookie', balancePath: '/api/user', balanceField: 'data.points', balanceDivisor: '1', checkinPath: '/api/checkin', checkinMethod: 'POST', credential: encrypt('session=legacy-generic'), tags: ['备用'], enabled: true }
  );
});

test('legacy newapi accounts run through the new-api adapter without migration', async () => {
  const account = await runAccount('legacy-newapi', 'poll');
  assert.equal(account.lastStatus, 'ok');
  assert.equal(account.balance, '$2.00');
  assert.equal(account.balanceRaw, 1000000);
  assert.equal(account.adapterId, 'new-api');
  assert.equal(account.detectedType, 'newapi');
});

test('legacy generic accounts keep their balance field and divisor semantics', async () => {
  const account = await runAccount('legacy-generic', 'poll');
  assert.equal(account.lastStatus, 'ok');
  assert.equal(account.balance, '120.00');
  assert.equal(account.balanceRaw, 120);
  assert.equal(account.adapterId, 'generic-json');
});

test('check-in still classifies business results through the adapter path', async () => {
  const account = await runAccount('legacy-newapi', 'checkin');
  assert.equal(account.lastCheckinStatus, 'ok');
  assert.equal(account.lastCheckinMessage, '签到成功');
  upstream.set('/api/user/checkin', { status: 200, body: { success: false, message: '今日已签到' } });
  try {
    const again = await runAccount('legacy-newapi', 'checkin');
    assert.equal(again.lastCheckinStatus, 'already');
  } finally {
    upstream.set('/api/user/checkin', { status: 200, body: { success: true, message: '签到成功' } });
  }
});

test('run failures carry a failure kind instead of a bare error', async () => {
  upstream.set('/api/user/self', { status: 401, body: { success: false, message: '无权进行此操作，未登录' } });
  try {
    const account = await runAccount('legacy-newapi', 'poll');
    assert.equal(account.lastStatus, 'error');
    assert.equal(account.lastErrorKind, 'auth_expired');
  } finally {
    upstream.set('/api/user/self', { status: 200, body: { success: true, data: { id: 42, username: 'tanggao', quota: 1000000, used_quota: 0 } } });
  }
});

test('new-api adapter exposes read-only capability probes over the context', async () => {
  const context = createAdapterContext({ baseUrl: 'https://example.com', credential: encrypt('session=x'), authType: 'cookie', userId: '42' });
  const status = await newApi.getCheckinStatus(context);
  assert.equal(status.supported, true);
  const user = await newApi.getUser(context);
  assert.equal(user.id, 42);
  const balance = await newApi.getBalance(context, { currency: 'auto' });
  assert.equal(balance.balance, '$2.00');
});

test('generic-json adapter reads configured fields over the context', async () => {
  const context = createAdapterContext({ baseUrl: 'https://example.com', credential: encrypt('session=x'), authType: 'cookie' });
  const balance = await genericJson.getBalance(context, { balancePath: '/api/user', balanceField: 'data.points', balanceDivisor: '1', currency: 'raw' });
  assert.equal(balance.rawBalance, 120);
  const checkin = await genericJson.checkin(context, { checkinPath: '/api/checkin', checkinMethod: 'POST' });
  assert.deepEqual(checkin, { status: 'ok', message: '签到成功' });
});

after(() => { globalThis.fetch = realFetch; });
