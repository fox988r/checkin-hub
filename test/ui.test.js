import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('add-site action clears the previous edit id', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /form\.elements\.id\.value\s*=\s*''/);
});

test('site cards include a safe external link', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /class="site-link"/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test('expired login hides the stale dashboard', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\$\('#app'\)\.classList\.add\('hidden'\)/);
  assert.match(source, /\$\('#logout'\)\.classList\.add\('hidden'\)/);
});

test('login explicitly sends cookies and shows progress', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /正在登录/);
  assert.match(source, /await load\(\)/);
});

test('dashboard accepts accounts without a selected model price', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!price\?\.text\) return ''/);
});

test('model picker preserves amount billing instead of forcing per-call', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /localStorage\.getItem\('modelBilling'\)/);
  assert.match(source, /localStorage\.setItem\('modelBilling', billing\)/);
  assert.match(source, /setBilling\(activeBilling\)/);
  assert.doesNotMatch(source, /preferredBilling/);
});

test('model picker never renders models left over from another site', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /pickedModels = \[\];\s*modelsLoading = true/);
  assert.match(source, /const requestSequence = \+\+modelLoadSequence/);
  assert.match(source, /requestSequence !== modelLoadSequence \|\| pickingAccount !== id/);
  assert.match(source, /if \(modelsLoading\)/);
});

test('custom bearer accounts can save automatic refresh settings', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /name="refreshPath"/);
  assert.match(html, /name="refreshCookie"/);
  assert.match(html, /遇到 401/);
  assert.match(html, /name="pricingCookie"/);
  assert.match(html, /name="modelBaseUrl"/);
  assert.match(html, /GET \/v1\/models/);
  assert.match(html, /name="refreshMode"/);
  assert.match(html, /服务器浏览器/);
  assert.match(source, /\/browser-open/);
});

test('server browser routes require the admin session', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const startup = fs.readFileSync(new URL('../start-container.sh', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/browser', auth/);
  assert.match(source, /app\.use\('\/browser', auth/);
  assert.match(source, /validSession\(cookies\(req\)\.session, sessionSecret\)/);
  assert.match(dockerfile, /chromium/);
  assert.match(startup, /\/data\/browser-profile/);
  assert.match(startup, /SingletonLock/);
  assert.match(startup, /json\/version/);
  assert.match(startup, /x11vnc .* -localhost/);
});

test('account save reports server validation errors and shows progress', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="accountSaveError"/);
  assert.match(source, /正在保存/);
  assert.match(source, /accountSaveError'\)\.textContent = error\.message/);
});

test('site cards include a real model invocation test', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, />测试模型</);
  assert.match(source, /\/model-test/);
  assert.match(source, /本次已真实调用/);
});

test('polling is controlled by account tags', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /#pollTags/);
  assert.match(source, /#addTagForm/);
  assert.match(source, /openTagPicker/);
  assert.match(source, /\/tags/);
  assert.match(source, /togglePollTag/);
  assert.doesNotMatch(source, /参与轮询<\/label>/);
});

test('tag filter and order controls are available', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /setTagFilter/);
  assert.match(source, /draggable="true"/);
  assert.match(source, /dropAccount/);
  assert.match(source, /\/api\/accounts\/order/);
  assert.doesNotMatch(source, /↑ 上移/);
  assert.doesNotMatch(source, /↓ 下移/);
});

test('created tags can be deleted with confirmation', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /deleteTag/);
  assert.match(source, /确定删除标签/);
  assert.match(source, /method: 'DELETE'/);
});

test('batch actions visibly run tagged sites one by one', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /async function runBatch/);
  assert.match(source, /for \(let index = 0; index < targets\.length/);
  assert.match(source, /正在.*\$\{index \+ 1\}\/\$\{targets\.length\}/);
  assert.match(source, /const targets = activeFilter/);
  assert.match(source, /当前筛选下没有可执行的站点/);
});

test('run logs distinguish gateway traffic', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /run\.action === 'gateway' \? '网关'/);
});

test('left navigation opens a real gateway statistics module', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /class="sidebar"/);
  assert.match(html, />调用统计</);
  assert.match(html, /id="trendChart"/);
  assert.match(source, /\/api\/stats\?\$\{query\}/);
  assert.match(html, /id="statsAccount"/);
  assert.match(html, /id="statsModel"/);
  assert.match(source, /class="success-bar"/);
});

test('left navigation includes filterable run logs', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, />运行日志</);
  assert.match(html, /id="logAction"/);
  assert.match(html, /id="logStatus"/);
  assert.match(html, /id="logAccount"/);
  assert.match(source, /\/api\/logs\?/);
});

test('left navigation includes unread per-call price alerts', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, />降价提醒/);
  assert.match(html, /id="priceAlertBadge"/);
  assert.match(html, /id="priceLeaders"/);
  assert.match(html, /id="priceAlertHistory"/);
  assert.match(source, /\/api\/price-alerts\/scan/);
  assert.match(source, /setPriceAlertBadge/);
});

test('public invite preview exposes only chosen names and links', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const invites = fs.readFileSync(new URL('../public/invites.js', import.meta.url), 'utf8');
  assert.match(html, /name="inviteUrl"/);
  assert.match(html, /href="\/invites\.html"/);
  assert.match(invites, /item\.name/);
  assert.match(invites, /item\.tags/);
  assert.match(invites, /item\.url/);
  assert.doesNotMatch(invites, /balance|apiKey|credential|modelName/);
});

test('browser import panel manages the token lifecycle in the dashboard', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /浏览器导入/);
  assert.match(html, /id="genImportToken"/);
  assert.match(html, /id="revokeImportToken"/);
  assert.match(html, /id="importRecords"/);
  assert.match(source, /\/api\/import\/token/);
  assert.match(source, /立即吊销旧 Token/);
  assert.match(source, /只显示这一次/);
  assert.match(source, /吊销导入 Token/);
});

test('site cards and records mark browser-imported accounts', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /source === 'browser-import'/);
  assert.match(source, /浏览器导入<\/span>/);
  assert.match(source, /checkinSupported/);
});

test('import routes use a dedicated token instead of the admin session', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const importer = fs.readFileSync(new URL('../src/browserImport.js', import.meta.url), 'utf8');
  assert.match(source, /installImportRoutes\(app, auth\)/);
  assert.match(importer, /app\.post\('\/api\/import\/account', importAuth/);
  assert.match(importer, /导入 Token 无效或已吊销/);
  assert.match(importer, /timingSafeEqual/);
  assert.match(importer, /sha256/);
  assert.doesNotMatch(importer, /ADMIN_PASSWORD/);
});

test('import never triggers check-in and reuses the existing verification helpers', () => {
  const importer = fs.readFileSync(new URL('../src/browserImport.js', import.meta.url), 'utf8');
  assert.match(importer, /method: 'GET'/);
  assert.doesNotMatch(importer, /method: 'POST'[\s\S]*checkin/);
  assert.match(importer, /from '\.\/runner\.js'/);
});

test('runner dispatches through the adapter registry instead of hardcoding panels', () => {
  const runner = fs.readFileSync(new URL('../src/runner.js', import.meta.url), 'utf8');
  const registry = fs.readFileSync(new URL('../adapters/registry.js', import.meta.url), 'utf8');
  assert.match(runner, /resolveAdapterForAccount\(account\)/);
  assert.doesNotMatch(runner, /async function runNewApi/);
  assert.doesNotMatch(runner, /async function runGeneric/);
  assert.match(registry, /adapterId: 'unknown'/);
  assert.match(registry, /adapterId: 'ambiguous'/);
});

test('adapters cannot bypass the safe fetch layer', () => {
  for (const file of ['adapters/new-api.js', 'adapters/generic-json.js', 'adapters/declarative.js', 'adapters/discovery.js']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fetch\((?!url)/, `${file} 不得直接调用原生 fetch`);
  }
  const context = fs.readFileSync(new URL('../adapters/context.js', import.meta.url), 'utf8');
  assert.match(context, /safeUrl/);
  assert.match(context, /dry-run/);
});

test('adapter system ships template, declarative example and docs', () => {
  const template = fs.readFileSync(new URL('../adapters/examples/template.js', import.meta.url), 'utf8');
  const docs = fs.readFileSync(new URL('../adapters/README.md', import.meta.url), 'utf8');
  const example = fs.readFileSync(new URL('../adapters/declarative/example-site.json.example', import.meta.url), 'utf8');
  for (const method of ['match(', 'detect(', 'getUser(', 'getBalance(', 'getCheckinStatus(', 'checkin(']) {
    assert.ok(template.includes(method), 'template should document ' + method);
  }
  assert.match(docs, /声明式适配器/);
  assert.match(docs, /Code Adapter/);
  JSON.parse(example);
});

test('failure kinds surface in the dashboard and logs', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /errorKindLabel/);
  assert.match(source, /登录失效/);
  const failures = fs.readFileSync(new URL('../adapters/failures.js', import.meta.url), 'utf8');
  for (const kind of ['auth_expired', 'endpoint_changed', 'rate_limited', 'network_error', 'unsupported']) {
    assert.match(failures, new RegExp(kind));
  }
});

test('auto check-in queue toggle is exposed with its server settings route', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const importer = fs.readFileSync(new URL('../src/browserImport.js', import.meta.url), 'utf8');
  assert.match(html, /id="autoCheckinOnImport"/);
  assert.match(html, /浏览器导入后自动加入签到队列/);
  assert.match(source, /toggleAutoCheckinOnImport/);
  assert.match(importer, /autoCheckinOnImport/);
  assert.match(importer, /自动签到/);
});

test('discovery endpoint stays read-only by construction', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const discovery = fs.readFileSync(new URL('../adapters/discovery.js', import.meta.url), 'utf8');
  assert.match(source, /dryRun: true/);
  assert.match(source, /\/api\/discover/);
  assert.doesNotMatch(discovery, /method: '(POST|PUT|PATCH|DELETE)'/);
});

test('notifier abstraction exists with a webhook implementation', () => {
  const registry = fs.readFileSync(new URL('../notifiers/registry.js', import.meta.url), 'utf8');
  const webhook = fs.readFileSync(new URL('../notifiers/webhook.js', import.meta.url), 'utf8');
  assert.match(registry, /registerNotifier/);
  assert.match(registry, /notifySafe/);
  assert.match(webhook, /NOTIFY_WEBHOOK_URL/);
});
