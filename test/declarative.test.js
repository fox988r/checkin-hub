import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeclarativeAdapter, validateDeclarative } from '../adapters/declarative.js';

const validConfig = {
  id: 'example-site',
  name: '示例站',
  match: { statusPath: '/api/status', jsonContains: ['site_name'] },
  auth: 'cookie',
  balance: { path: '/api/user', field: 'data.points', divisor: 1 },
  checkinStatus: { path: '/api/checkin/status', field: 'data.checked' },
  checkin: { path: '/api/checkin', method: 'POST' }
};

test('declarative configs pass schema validation', () => {
  assert.deepEqual(validateDeclarative(validConfig), []);
  assert.deepEqual(validateDeclarative({ ...validConfig, match: undefined }), []);
});

test('declarative configs reject invalid shapes with explicit reasons', () => {
  assert.ok(validateDeclarative(null).length > 0);
  assert.ok(validateDeclarative({ ...validConfig, id: 'BAD ID' }).some(x => /id/.test(x)));
  assert.ok(validateDeclarative({ ...validConfig, auth: 'session' }).some(x => /auth/.test(x)));
  assert.ok(validateDeclarative({ ...validConfig, balance: { path: 'api/user', field: '' } }).some(x => /balance/.test(x)));
  assert.ok(validateDeclarative({ ...validConfig, checkin: { path: '/api/checkin', method: 'PATCH' } }).some(x => /method/.test(x)));
  assert.ok(validateDeclarative({ ...validConfig, checkinStatus: { path: '/x', field: '' } }).some(x => /checkinStatus/.test(x)));
  assert.ok(validateDeclarative({ ...validConfig, match: { statusPath: '/x', jsonContains: [1] } }).some(x => /jsonContains/.test(x)));
});

test('declarative adapters match, read balances and classify check-ins', async () => {
  const adapter = buildDeclarativeAdapter(validConfig);
  const context = {
    fetchJson: async (path, options = {}) => {
      if (path === '/api/status') return { status: 200, data: { data: { site_name: '示例站' } } };
      if (path === '/api/user') return { status: 200, data: { data: { points: 24495 } } };
      if (path === '/api/checkin/status') return { status: 200, data: { data: { checked: false } } };
      if (path === '/api/checkin') {
        if ((options.method || 'GET') !== 'POST') throw new Error('签到必须用 POST');
        return { status: 200, data: { success: true, message: '签到成功' } };
      }
      return { status: 404, data: null };
    }
  };
  const match = await adapter.match(context);
  assert.deepEqual([match.score, adapter.id], [90, 'example-site']);
  const balance = await adapter.getBalance(context);
  assert.equal(balance.balance, '24495.00');
  assert.equal(balance.rawBalance, 24495);
  const checkinStatus = await adapter.getCheckinStatus(context);
  assert.deepEqual([checkinStatus.supported, checkinStatus.checkedToday], [true, false]);
  assert.deepEqual(await adapter.checkin(context), { status: 'ok', message: '签到成功' });
});

test('declarative match fails closed when jsonContains tokens are missing', async () => {
  const adapter = buildDeclarativeAdapter(validConfig);
  const result = await adapter.match({ fetchJson: async () => ({ status: 200, data: { data: { hello: 1 } } }) });
  assert.equal(result.score, 0);
});

test('dry-run declarative check-in is blocked before any write request leaves', async () => {
  const { createAdapterContext } = await import('../adapters/context.js');
  const { encrypt } = await import('../src/store.js');
  const adapter = buildDeclarativeAdapter(validConfig);
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init.method || 'GET');
    return { ok: true, status: 200, headers: new Headers(), text: async () => '{"success":true}' };
  };
  try {
    const context = createAdapterContext({ baseUrl: 'https://example.com', credential: encrypt('session=x'), authType: 'cookie' }, { dryRun: true });
    await assert.rejects(() => adapter.checkin(context), /dry-run/);
    assert.ok(!seen.includes('POST'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

after(() => {});
