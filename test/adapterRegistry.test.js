import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterContext } from '../adapters/context.js';
import { classifyFailure, describeFailureKind, FAILURE_KINDS } from '../adapters/failures.js';
import { getRegistry, matchAdapters, registerAdapter, resetRegistryForTests } from '../adapters/registry.js';

const panelStatus = { status: 200, data: { success: true, data: { system_name: '糖糕站', version: 'v1.2.3', quota_per_unit: 500000 } } };

const stubContext = responses => ({
  baseUrl: 'https://example.com',
  fetchJson: async path => responses[path] || { status: 404, data: null },
  fetchText: async path => responses[path] || { status: 404, data: null, text: '' }
});

test('registry ships built-in adapters and validates their shape', () => {
  const reg = getRegistry();
  for (const id of ['new-api', 'one-api', 'generic-json']) {
    const adapter = reg.get(id);
    assert.ok(adapter, `${id} should be registered`);
    assert.equal(typeof adapter.match, 'function');
    assert.equal(typeof adapter.run, 'function');
  }
});

test('matching picks the highest scoring adapter with confidence and reasons', async () => {
  const result = await matchAdapters(stubContext({ '/api/status': panelStatus }));
  assert.equal(result.adapterId, 'new-api');
  assert.equal(result.confidence, 0.95);
  assert.ok(result.reasons.some(reason => /api\/status/.test(reason)));
});

test('one-api never ties with new-api on the same protocol shape', async () => {
  const result = await matchAdapters(stubContext({ '/api/status': panelStatus }));
  assert.notEqual(result.adapterId, 'ambiguous');
  assert.equal(result.adapterId, 'new-api');
});

test('low scores resolve to unknown instead of guessing', async () => {
  const result = await matchAdapters(stubContext({ '/api/status': { status: 200, data: null } }));
  assert.equal(result.adapterId, 'unknown');
  assert.equal(result.confidence, 0);
});

test('a tied top score returns ambiguous instead of blindly picking one', async () => {
  const fake = reason => ({ id: `tie-${reason}`, name: reason, auth: 'cookie', async match() { return { score: 80, reason }; }, async run() { throw new Error('not used'); } });
  const result = await matchAdapters(stubContext({}), { adapters: [fake('alpha'), fake('beta')] });
  assert.equal(result.adapterId, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});

test('adapter match crashes are contained and scored as zero', async () => {
  const crasher = { id: 'crasher', name: 'crasher', auth: 'cookie', async match() { throw new Error('boom'); }, async run() {} };
  const solid = { id: 'solid', name: 'solid', auth: 'cookie', async match() { return { score: 70, reason: 'ok' }; }, async run() {} };
  const result = await matchAdapters(stubContext({}), { adapters: [crasher, solid] });
  assert.equal(result.adapterId, 'solid');
  assert.equal(result.confidence, 0.7);
});

test('declarative adapters can register through the normal path', async () => {
  resetRegistryForTests();
  const adapter = { id: 'mini-site', name: 'Mini', auth: 'cookie', async match() { return { score: 60, reason: 'mini' }; }, async run() {} };
  registerAdapter(adapter);
  assert.equal(getRegistry().get('mini-site').id, 'mini-site');
  const result = await matchAdapters(stubContext({}));
  assert.equal(result.adapterId, 'mini-site');
  assert.equal(result.confidence, 0.6);
  resetRegistryForTests();
});

test('dry-run context blocks every write method but allows reads', async () => {
  const context = createAdapterContext({ baseUrl: 'https://example.com', credential: '', authType: 'none' }, { dryRun: true });
  const blocked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    blocked.push(init.method || 'GET');
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"success":true}' };
  };
  try {
    await context.fetchJson('/api/status', { auth: false });
    await assert.rejects(() => context.fetchJson('/api/checkin', { method: 'POST' }), /dry-run/);
    await assert.rejects(() => context.fetchJson('/api/user', { method: 'PUT' }), /dry-run/);
    await assert.rejects(() => context.fetchJson('/api/user/1', { method: 'DELETE' }), /dry-run/);
    assert.deepEqual(blocked, ['GET']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('failures are classified instead of collapsing into one error', () => {
  const cases = [
    ['无权进行此操作，未登录 (HTTP 401)', 'auth_expired'],
    ['自动刷新失败：HTTP 403', 'auth_expired'],
    ['接口不存在 (HTTP 404)', 'endpoint_changed'],
    ['HTTP 429', 'rate_limited'],
    ['请求过于频繁，请稍后再试', 'rate_limited'],
    ['今日已签到', 'already_checked'],
    ['只允许 HTTPS 站点', 'unsupported'],
    ['fetch failed', 'network_error'],
    ['接口返回网页而不是 JSON (HTTP 200)', 'unknown'],
    ['The truth is out there', 'unknown']
  ];
  for (const [message, kind] of cases) {
    assert.equal(classifyFailure(new Error(message)), kind, message);
  }
  for (const kind of FAILURE_KINDS) assert.ok(describeFailureKind(kind));
});
