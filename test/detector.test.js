import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSiteName, dedupeOrigins, detectSite, describeSite, formatBalance, pickUserIdCandidates, summarizeScan } from '../browser-extension/detector.js';

const statusOk = { status: 200, data: { success: true, data: { system_name: '糖糕站', version: 'v1.2.3', quota_per_unit: 500000 } } };
const selfOk = { status: 200, data: { success: true, data: { id: 42, username: 'tanggao', quota: 1625000, used_quota: 0 } } };

test('dedupes tabs by origin and skips non-web and hub pages', () => {
  const { targets, skipped } = dedupeOrigins([
    { id: 1, url: 'https://a.example.com/console' },
    { id: 2, url: 'https://a.example.com/other' },
    { id: 3, url: 'https://b.example.com/' },
    { id: 4, url: 'chrome://extensions/' },
    { id: 5, url: 'about:blank' },
    { id: 6, url: 'file:///etc/hosts' },
    { id: 7, url: 'https://hub.example.com/' },
    { id: 8 }
  ], 'https://hub.example.com');
  assert.deepEqual(targets.map(x => [x.origin, x.tabId]), [['https://a.example.com', 1], ['https://b.example.com', 3]]);
  assert.equal(skipped.length, 4);
});

test('extracts numeric user ids from storage without dumping everything', () => {
  const candidates = pickUserIdCandidates({
    localStorage: [
      ['user', '{"id": 42, "username": "tanggao"}'],
      ['uid', '42'],
      ['theme', 'dark'],
      ['session', 'not-a-number-object'],
      ['account', '{"user_id": "77"}']
    ],
    sessionStorage: [['uid', '42']]
  });
  assert.deepEqual(candidates, ['42', '77']);
  assert.equal(pickUserIdCandidates({ localStorage: [['random', '{"data": 1}']], sessionStorage: [] }).length, 0);
});

test('detects a logged-in New API site with balance and checkin state', () => {
  const site = detectSite({
    origin: 'https://a.example.com', title: '糖糕站 - New API',
    status: statusOk, self: selfOk, checkin: { status: 405, data: null }, userId: '42', candidates: ['42']
  });
  assert.equal(site.panelType, 'newapi');
  assert.equal(site.loggedIn, true);
  assert.equal(site.status, 'ok');
  assert.equal(site.name, '糖糕站');
  assert.equal(site.userId, '42');
  assert.equal(site.balance, '$3.25');
  assert.equal(site.checkinSupported, true);
  assert.equal(site.importable, true);
  assert.match(describeSite(site), /New API Adapter · 已登录 · 可签到 · 余额 \$3\.25/);
});

test('treats a 404 checkin probe as unconfirmed instead of unsupported', () => {
  const site = detectSite({
    origin: 'https://a.example.com', title: '糖糕站',
    status: statusOk, self: selfOk, checkin: { status: 404, data: { message: 'Not Found' } }, userId: '42', candidates: ['42']
  });
  assert.equal(site.checkinSupported, null);
  assert.match(describeSite(site), /签到接口未确认/);
});

test('reports a recognized panel with a missing user id for manual completion', () => {
  const site = detectSite({
    origin: 'https://a.example.com', title: '一元站',
    status: statusOk, self: { status: 401, data: null }, checkin: { status: 401, data: null }, userId: '', candidates: []
  });
  assert.equal(site.status, 'missing-user-id');
  assert.equal(site.importable, false);
  assert.equal(site.checkinSupported, true);
  assert.match(describeSite(site), /未自动找到用户 ID/);
});

test('reports an expired login after candidate ids were tried', () => {
  const site = detectSite({
    origin: 'https://a.example.com', title: '一元站',
    status: statusOk, self: { status: 401, data: null }, checkin: { status: 0 }, userId: '', candidates: ['42', '77']
  });
  assert.equal(site.status, 'unauthenticated');
  assert.match(describeSite(site), /未登录或登录已过期/);
});

test('marks non-panel sites as unsupported', () => {
  const site = detectSite({
    origin: 'https://blog.example.com', title: '我的博客',
    status: { status: 200, data: null }, self: { status: 404, data: { message: 'Not Found' } }, checkin: { status: 0 }, userId: '', candidates: []
  });
  assert.equal(site.status, 'unsupported');
  assert.equal(site.importable, false);
  assert.match(describeSite(site), /非支持站点/);
});

test('formats balances with site quota settings', () => {
  assert.equal(formatBalance(1625000, statusOk.data), '$3.25');
  assert.equal(formatBalance(1625000, { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7.2 } }), '¥23.40');
  assert.equal(formatBalance('bad', {}), '—');
});

test('cleans panel suffixes from site titles', () => {
  assert.equal(cleanSiteName('糖糕站 - New API', 'https://a.example.com'), '糖糕站');
  assert.equal(cleanSiteName('一元站 | One API', 'https://b.example.com'), '一元站');
  assert.equal(cleanSiteName('', 'https://c.example.com'), 'c.example.com');
});

test('summarizes scan results', () => {
  const summary = summarizeScan([
    { panelType: 'newapi', importable: true },
    { panelType: 'newapi', importable: false },
    { panelType: 'unsupported', importable: false }
  ]);
  assert.deepEqual(summary, { total: 3, supported: 2, importable: 1 });
});

test('unknown sites surface read-only discovery instead of support claims', () => {
  const site = detectSite({
    origin: 'https://forum.example.com', title: '论坛',
    status: { status: 200, data: null }, self: { status: 404, data: null }, checkin: { status: 0 },
    userId: '', candidates: [],
    discovery: {
      possibleUserEndpoints: [{ path: '/api/me' }],
      possibleBalanceEndpoints: [{ path: '/api/points' }],
      possibleCheckinEndpoints: [{ path: '/api/checkin/status' }]
    }
  });
  assert.equal(site.status, 'unknown-site');
  assert.equal(site.importable, false);
  const description = describeSite(site);
  assert.match(description, /Unknown Site/);
  assert.match(description, /疑似签到接口/);
  assert.match(description, /人工确认/);
});

test('sites with no discovery hints stay plainly unsupported', () => {
  const site = detectSite({
    origin: 'https://blog.example.com', title: '博客',
    status: { status: 200, data: null }, self: { status: 404, data: null }, checkin: { status: 0 },
    userId: '', candidates: [], discovery: { possibleUserEndpoints: [], possibleBalanceEndpoints: [], possibleCheckinEndpoints: [] }
  });
  assert.equal(site.status, 'unsupported');
  assert.match(describeSite(site), /非支持站点/);
});
