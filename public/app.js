const $ = s => document.querySelector(s);
let accounts = []; let tags = []; let dashboardData = null; let activeFilter = '';

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function priceWithEstimate(price = {}) {
  if (!price?.text) return '';
  if (price.type !== 'per_call') return price.text;
  if (price.estimatedCalls === 'unlimited') return `${price.text} · 预计不限次数`;
  if (Number.isInteger(price.estimatedCalls)) return `${price.text} · 预计还可 ${price.estimatedCalls.toLocaleString()} 次`;
  return `${price.text} · 刷新余额后估算`;
}

async function load() {
  try {
    const data = await api('/api/dashboard');
    accounts = data.accounts;
    tags = data.tags || [];
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    render(data);
    loadImportInfo();
  } catch {
    accounts = [];
    $('#login').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#logout').classList.add('hidden');
  }
}

function render(data) {
  dashboardData = data;
  $('#siteCount').textContent = data.accounts.length;
  $('#okCount').textContent = data.accounts.filter(x => x.lastStatus === 'ok').length;
  $('#errorCount').textContent = data.accounts.filter(x => x.lastStatus === 'error').length;
  const allTags = [...new Set(data.tags || [])].sort((a, b) => a.localeCompare(b));
  const enabledTags = new Set(data.pollTags || []);
  $('#pollTags').innerHTML = allTags.map(tag => `<span class="tag-item"><button class="tag-toggle ${enabledTags.has(tag) ? 'active' : 'ghost'}" data-tag="${esc(tag)}" onclick="togglePollTag(this.dataset.tag,${!enabledTags.has(tag)})">${enabledTags.has(tag) ? '✓ ' : ''}${esc(tag)}</button><button class="tag-delete" data-tag="${esc(tag)}" onclick="deleteTag(this.dataset.tag)" title="删除标签">×</button></span>`).join('') || '<span class="hint">先在这里添加一个标签。</span>';
  $('#filterTags').innerHTML = `<button class="tag-toggle ${activeFilter ? 'ghost' : 'active'}" onclick="setTagFilter('')">全部</button>` + allTags.map(tag => `<button class="tag-toggle ${activeFilter === tag ? 'active' : 'ghost'}" data-tag="${esc(tag)}" onclick="setTagFilter(this.dataset.tag)">${esc(tag)}</button>`).join('');
  const visibleAccounts = activeFilter ? data.accounts.filter(account => (account.tags || []).includes(activeFilter)) : data.accounts;
  $('#cards').innerHTML = visibleAccounts.length ? visibleAccounts.map(a => `
    <article class="card" draggable="true" ondragstart="startAccountDrag(event,'${a.id}')" ondragover="dragAccountOver(event)" ondragleave="this.classList.remove('drag-over')" ondrop="dropAccount(event,'${a.id}')" ondragend="endAccountDrag(event)">
      <div class="top"><strong>${esc(a.name)}</strong><span class="drag-handle" title="拖动排序">⋮⋮</span><span class="status ${a.lastStatus === 'error' ? 'error' : ''}">${a.lastStatus === 'error' ? '异常' : a.lastStatus === 'ok' ? '正常' : '未运行'}</span></div>
      <div class="site-tags">${(a.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('') || '<span class="empty-tag">未设置标签</span>'}</div>
      <a class="site-link" href="${esc(a.baseUrl)}" target="_blank" rel="noopener noreferrer">打开站点 ↗</a>
      ${a.refreshMode === 'browser' ? '<span class="browser-badge">服务器浏览器续期</span>' : ''}
      ${a.source === 'browser-import' ? '<span class="browser-badge">浏览器导入</span>' : ''}
      ${a.checkinSupported === true ? '<span class="checkin-badge">签到接口 ✅</span>' : a.checkinSupported === null && a.source === 'browser-import' ? '<span class="checkin-badge unknown">签到接口待验证</span>' : ''}
      <div class="balance">${esc(a.balance ?? '—')}</div>
      <div class="model-box"><strong>${esc(a.modelName || '尚未选择模型')}</strong><span>${esc(priceWithEstimate(a.modelPrice) || (a.hasApiKey ? '点击选择模型并查看价格' : '请先编辑并填写 API Key'))}</span></div>
      <p class="meta">${a.lastError ? esc(a.lastError) : a.lastCheckinMessage ? esc(a.lastCheckinMessage) : a.lastCheckedAt ? '更新于 ' + new Date(a.lastCheckedAt).toLocaleString() : '等待首次刷新'}</p>
      <div class="card-actions"><button onclick="run('${a.id}','poll')">刷新</button><button class="secondary" onclick="run('${a.id}','checkin')">签到</button><button class="ghost" onclick="openTagPicker('${a.id}')">选择标签</button><button class="ghost" onclick="openModels('${a.id}')">选择模型</button><button class="ghost" onclick="testModel('${a.id}',this)">测试模型</button>${a.refreshMode === 'browser' ? `<button class="ghost" onclick="openServerBrowser('${a.id}')">浏览器登录</button>` : ''}<button class="ghost" onclick="edit('${a.id}')">编辑</button><button class="ghost" onclick="removeAccount('${a.id}')">删除</button></div>
    </article>`).join('') : `<article class="panel"><p>${activeFilter ? '这个标签下还没有站点。' : '还没有站点，先添加一个。'}</p></article>`;
}

window.showView = view => {
  $('#dashboardView').classList.toggle('hidden', view !== 'dashboard');
  $('#statsView').classList.toggle('hidden', view !== 'stats');
  $('#logsView').classList.toggle('hidden', view !== 'logs');
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'stats') loadStats();
  if (view === 'logs') loadLogs();
};

window.loadStats = async () => {
  try {
    const range = Number($('#trendRange').value || 7);
    const query = new URLSearchParams({ days: range, accountId: $('#statsAccount').value, modelName: $('#statsModel').value });
    const data = await api(`/api/stats?${query}`);
    const selectedAccount = $('#statsAccount').value; const selectedModel = $('#statsModel').value;
    $('#statsAccount').innerHTML = '<option value="">全部站点</option>' + data.filters.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join('');
    $('#statsModel').innerHTML = '<option value="">全部模型</option>' + data.filters.models.map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join('');
    $('#statsAccount').value = selectedAccount; $('#statsModel').value = selectedModel;
    const accountLabel = data.filters.accounts.find(account => account.id === selectedAccount)?.name || '全部站点';
    $('#statsScope').textContent = `当前范围：${accountLabel} · ${selectedModel || '全部模型'}`;
    $('#statsUpdatedAt').textContent = `更新于 ${new Date(data.updatedAt).toLocaleTimeString()}`;
    $('#todayRequests').textContent = data.today.requests.toLocaleString();
    $('#todaySuccessRate').textContent = `${data.today.successRate}%`;
    $('#monthRequests').textContent = data.month.requests.toLocaleString();
    $('#allResults').textContent = `${data.all.successful.toLocaleString()} / ${data.all.failed.toLocaleString()}`;
    $('#firstHitRate').textContent = `${data.all.firstHitRate}%`;
    $('#switchCount').textContent = data.all.switched.toLocaleString();
    $('#averageLatency').textContent = data.all.averageLatencyMs === null ? '—' : `${data.all.averageLatencyMs} ms`;
    $('#p95Latency').textContent = data.all.p95LatencyMs === null ? '—' : `${data.all.p95LatencyMs} ms`;
    $('#inputTokens').textContent = data.tokens.all.input.toLocaleString(); $('#todayInputTokens').textContent = `今日 ${data.tokens.today.input.toLocaleString()}`;
    $('#outputTokens').textContent = data.tokens.all.output.toLocaleString(); $('#todayOutputTokens').textContent = `今日 ${data.tokens.today.output.toLocaleString()}`;
    $('#cachedTokens').textContent = data.tokens.all.cached.toLocaleString(); $('#todayCachedTokens').textContent = `今日 ${data.tokens.today.cached.toLocaleString()}`;
    $('#totalTokens').textContent = data.tokens.all.total.toLocaleString(); $('#measuredRequests').textContent = `${data.tokens.all.measured.toLocaleString()} 次返回用量`;
    $('#trendTitle').textContent = `近 ${range} 天请求`;
    const max = Math.max(1, ...data.days.map(day => day.requests));
    $('#trendChart').innerHTML = data.days.map(day => `<div class="trend-day"><div class="trend-bar"><i style="height:${Math.max(day.requests ? 8 : 2, day.requests / max * 100)}%"></i></div><strong>${day.requests}</strong><span>${esc(day.date.slice(5))}</span></div>`).join('');
    const rows = list => list.map((row, index) => `<div><b>${index + 1}</b><span><strong>${esc(row.name)}</strong><small>${row.attempts} 次尝试 · 成功 ${row.successful} · 失败 ${row.failed}</small><i class="success-bar"><u style="width:${row.successRate}%"></u></i></span><em>${row.successRate}%<small>${row.averageLatencyMs === null ? '—' : row.averageLatencyMs + ' ms'}</small></em></div>`).join('') || '<p>当前范围还没有网关调用记录。</p>';
    $('#siteRanking').innerHTML = rows(data.sites);
    $('#modelRanking').innerHTML = rows(data.models);
    const compactRows = list => list.map((row, index) => `<div><b>${index + 1}</b><span><strong>${esc(row.name)}</strong></span><em>${row.count.toLocaleString()} 次</em></div>`).join('') || '<p>暂无记录。</p>';
    $('#failureRanking').innerHTML = compactRows(data.failures);
    $('#endpointRanking').innerHTML = compactRows(data.endpoints);
  } catch (error) { alert(`统计加载失败：${error.message}`); }
};

window.loadLogs = async () => {
  try {
    const query = new URLSearchParams({ action: $('#logAction').value, status: $('#logStatus').value, accountId: $('#logAccount').value });
    const data = await api(`/api/logs?${query}`);
    const selected = $('#logAccount').value;
    $('#logAccount').innerHTML = '<option value="">全部站点</option>' + data.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join('');
    $('#logAccount').value = selected;
    $('#logResults').innerHTML = data.runs.map(run => {
      const action = run.action === 'gateway' ? '网关' : run.action === 'checkin' ? '签到' : '轮询';
      const result = run.status === 'ok' ? '成功' : run.status === 'already' ? '已签到' : '失败';
      const usage = Number.isFinite(run.totalTokens) ? `输入 ${run.inputTokens || 0} · 输出 ${run.outputTokens || 0} · 缓存 ${run.cachedTokens || 0} · 总计 ${run.totalTokens}` : '';
      const details = [run.modelName, usage, Number.isFinite(run.latencyMs) ? `${run.latencyMs} ms` : '', run.statusCode ? `HTTP ${run.statusCode}` : ''].filter(Boolean).join(' · ');
      return `<article><time>${new Date(run.startedAt).toLocaleString()}</time><strong>${esc(run.accountName)}</strong><span class="log-kind">${action}</span><span class="${run.status}">${result}</span><p>${esc(details || run.message || '—')}</p></article>`;
    }).join('') || '<p>当前筛选下没有日志。</p>';
  } catch (error) { alert(`日志加载失败：${error.message}`); }
};
for (const selector of ['#logAction', '#logStatus', '#logAccount']) document.addEventListener('change', event => { if (event.target.matches(selector)) loadLogs(); });

window.setTagFilter = tag => { activeFilter = tag; render(dashboardData); };
let draggedAccount = '';
window.startAccountDrag = (event, id) => { draggedAccount = id; event.dataTransfer.effectAllowed = 'move'; event.currentTarget.classList.add('dragging'); };
window.dragAccountOver = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; event.currentTarget.classList.add('drag-over'); };
window.endAccountDrag = event => { event.currentTarget.classList.remove('dragging'); document.querySelectorAll('.drag-over').forEach(card => card.classList.remove('drag-over')); };
window.dropAccount = async (event, targetId) => {
  event.preventDefault(); event.currentTarget.classList.remove('drag-over');
  if (!draggedAccount || draggedAccount === targetId) return;
  const visible = activeFilter ? accounts.filter(account => (account.tags || []).includes(activeFilter)) : [...accounts];
  const from = visible.findIndex(account => account.id === draggedAccount); const target = visible.findIndex(account => account.id === targetId);
  if (from < 0 || target < 0) return;
  const [moved] = visible.splice(from, 1); const rect = event.currentTarget.getBoundingClientRect();
  let insertAt = visible.findIndex(account => account.id === targetId);
  if (event.clientY > rect.top + rect.height / 2) insertAt += 1;
  visible.splice(insertAt, 0, moved); draggedAccount = '';
  await api('/api/accounts/order', { method: 'POST', body: JSON.stringify({ orderedIds: visible.map(account => account.id) }) });
  await load();
};

$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button');
  button.disabled = true;
  button.textContent = '正在登录…';
  $('#loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: new FormData(event.target).get('password') }) });
    await load();
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '进入控制台'; }
};

async function loadImportInfo() {
  try {
    const [tokenData, recordData] = await Promise.all([api('/api/import/token'), api('/api/import/records')]);
    $('#importTokenStatus').textContent = tokenData.active
      ? `Token 已生成 · ${new Date(tokenData.createdAt).toLocaleString()}${tokenData.lastUsedAt ? ` · 最近使用 ${new Date(tokenData.lastUsedAt).toLocaleString()}` : ' · 尚未使用'}`
      : '尚未生成导入 Token';
    $('#revokeImportToken').classList.toggle('hidden', !tokenData.active);
    $('#genImportToken').textContent = tokenData.active ? '重新生成' : '生成导入 Token';
    $('#importRecords').innerHTML = (recordData.records || []).map(record => {
      const label = record.result === 'created' ? '新增' : record.result === 'updated' ? '更新' : '失败';
      return `<span class="import-record ${record.result === 'failed' ? 'failed' : ''}">${esc(record.name)} · ${esc(record.origin)} · ${label}${record.message ? ` · ${esc(record.message)}` : ''} · ${new Date(record.at).toLocaleString()}</span>`;
    }).join('') || '<span class="hint">还没有浏览器导入记录。</span>';
  } catch { $('#importTokenStatus').textContent = '加载失败'; }
}
window.generateImportToken = async () => {
  if (!confirm('生成新 Token 会立即吊销旧 Token，正在使用的扩展需要更新，继续？')) return;
  try {
    const data = await api('/api/import/token', { method: 'POST' });
    const box = $('#importTokenValue');
    box.classList.remove('hidden');
    box.textContent = `新 Token（只显示这一次，请立即复制到扩展）：${data.token}`;
    loadImportInfo();
  } catch (error) { alert(error.message); }
};
window.revokeImportToken = async () => {
  if (!confirm('确定吊销导入 Token？吊销后扩展将无法导入站点。')) return;
  try { await api('/api/import/token', { method: 'DELETE' }); $('#importTokenValue').classList.add('hidden'); loadImportInfo(); }
  catch (error) { alert(error.message); }
};
$('#genImportToken').onclick = () => generateImportToken();
$('#revokeImportToken').onclick = () => revokeImportToken();

$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('#addTagForm').onsubmit = async event => {
  event.preventDefault(); const form = event.target; const tag = new FormData(form).get('tag');
  try { await api('/api/tags', { method: 'POST', body: JSON.stringify({ tag }) }); form.reset(); load(); }
  catch (error) { alert(error.message); }
};
$('#add').onclick = () => { const form = $('#accountForm'); form.reset(); form.elements.id.value = ''; $('#accountSaveError').textContent = ''; toggleFields(); $('#editor').showModal(); };
$('#cancel').onclick = () => $('#editor').close();
function toggleFields() { const custom = $('#panelType').value === 'generic'; $('#simpleFields').classList.toggle('hidden', custom); $('#advancedFields').classList.toggle('hidden', !custom); }
$('#panelType').onchange = toggleFields;
$('#accountForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('#accountSaveButton');
  $('#accountSaveError').textContent = '';
  const values = Object.fromEntries(new FormData(event.target));
  if (values.panelType === 'generic') values.credential = values.genericCredential;
  delete values.genericCredential;
  button.disabled = true; button.textContent = '正在保存…';
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify(values) });
    $('#editor').close(); await load();
  } catch (error) { $('#accountSaveError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '保存'; }
};

window.edit = id => { const account = accounts.find(x => x.id === id), form = $('#accountForm'); form.reset(); $('#accountSaveError').textContent = ''; Object.entries(account).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ''; }); toggleFields(); $('#editor').showModal(); };
window.run = async (id, action) => { try { await api(`/api/accounts/${id}/${action}`, { method: 'POST' }); } catch (error) { alert(error.message); } load(); };
window.openServerBrowser = async id => {
  const browserWindow = window.open('about:blank', 'sitePointsServerBrowser');
  try {
    await api(`/api/accounts/${id}/browser-open`, { method: 'POST' });
    if (browserWindow) browserWindow.location = '/browser'; else location.href = '/browser';
  } catch (error) {
    browserWindow?.close();
    alert(`服务器浏览器打开失败：${error.message}`);
  }
};
let taggingAccount = '';
window.openTagPicker = id => {
  taggingAccount = id; const account = accounts.find(x => x.id === id); const selected = new Set(account.tags || []);
  $('#tagPickerTitle').textContent = `${account.name} · 选择标签`;
  $('#tagChoices').innerHTML = tags.map(tag => `<label><input type="checkbox" name="tags" value="${esc(tag)}" ${selected.has(tag) ? 'checked' : ''}> ${esc(tag)}</label>`).join('') || '<p>还没有标签，请先在页面顶部添加。</p>';
  $('#tagPicker').showModal();
};
$('#tagPickerForm').onsubmit = async event => {
  event.preventDefault(); const selected = new FormData(event.target).getAll('tags');
  await api(`/api/accounts/${taggingAccount}/tags`, { method: 'POST', body: JSON.stringify({ tags: selected }) });
  $('#tagPicker').close(); load();
};
$('#closeTags').onclick = () => $('#tagPicker').close();
let pickingAccount = ''; let pickedModels = []; let modelLoadSequence = 0; let modelsLoading = false;
let activeBilling = localStorage.getItem('modelBilling') === 'token' ? 'token' : 'call';
function showCategory(category) {
  document.querySelectorAll('.category-button').forEach(button => button.classList.toggle('active', button.dataset.category === category));
  const models = pickedModels.filter(model => model.billing === activeBilling && model.category === category);
  $('#modelChoices').innerHTML = models.map(model => {
    const estimate = model.estimatedCalls === 'unlimited' ? ' · 预计不限次数' : Number.isInteger(model.estimatedCalls) ? ` · 预计还可 ${model.estimatedCalls.toLocaleString()} 次` : ' · 刷新余额后估算';
    return `<button class="model-choice" data-model="${esc(model.name)}" onclick="chooseModel(this.dataset.model)"><span>${esc(model.name)}</span><strong>${esc(model.text + (model.billing === 'call' ? estimate : ''))}</strong></button>`;
  }).join('') || '<p>这个分类没有模型。</p>';
}
function renderCategories() {
  if (modelsLoading) {
    $('#modelCategories').innerHTML = '<p>正在拉取当前站点的模型和价格…</p>';
    $('#modelChoices').innerHTML = '';
    return;
  }
  const visible = pickedModels.filter(model => model.billing === activeBilling);
  const categories = [...new Set(visible.map(model => model.category))];
  $('#modelCategories').innerHTML = categories.map(category => `<button class="category-button ghost" data-category="${esc(category)}" onclick="showCategory('${esc(category)}')">${esc(category)} <small>${visible.filter(model => model.category === category).length}</small></button>`).join('') || `<p>没有找到可用的${activeBilling === 'call' ? '按次' : '按量'}模型。</p>`;
  $('#modelChoices').innerHTML = '';
  if (categories.length) showCategory(categories[0]);
}
window.setBilling = billing => { activeBilling = billing; localStorage.setItem('modelBilling', billing); document.querySelectorAll('.billing-button').forEach(button => { const active = button.dataset.billing === billing; button.classList.toggle('active', active); button.classList.toggle('ghost', !active); }); renderCategories(); };
window.openModels = async id => {
  const requestSequence = ++modelLoadSequence;
  pickingAccount = id;
  const account = accounts.find(x => x.id === id);
  if (!account?.hasApiKey) return alert('请先编辑站点并填写 API Key');
  pickedModels = [];
  modelsLoading = true;
  $('#modelPickerTitle').textContent = `${account.name} · 选择模型`;
  $('#modelPicker').showModal();
  setBilling(activeBilling);
  try {
    const models = (await api(`/api/accounts/${id}/models`, { method: 'POST' })).models;
    if (requestSequence !== modelLoadSequence || pickingAccount !== id) return;
    pickedModels = models;
    modelsLoading = false;
    setBilling(activeBilling);
  } catch (error) {
    if (requestSequence !== modelLoadSequence || pickingAccount !== id) return;
    modelsLoading = false;
    $('#modelCategories').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
};
window.showCategory = showCategory;
window.chooseModel = async model => { await api(`/api/accounts/${pickingAccount}/model`, { method: 'POST', body: JSON.stringify({ model }) }); $('#modelPicker').close(); load(); };
window.testModel = async (id, button) => {
  const original = button.textContent;
  button.disabled = true; button.textContent = '测试中…';
  try {
    const result = await api(`/api/accounts/${id}/model-test`, { method: 'POST' });
    alert(`模型调用成功：${result.model}\n响应耗时：${result.latencyMs} ms\n本次已真实调用，会计入上游使用记录并消耗相应额度。`);
  } catch (error) { alert(`模型连接失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = original; }
};
$('#closeModels').onclick = () => {
  modelLoadSequence++;
  modelsLoading = false;
  pickedModels = [];
  $('#modelPicker').close();
};
window.togglePollTag = async (tag, enabled) => { try { await api('/api/poll-tags', { method: 'POST', body: JSON.stringify({ tag, enabled }) }); load(); } catch (error) { alert(error.message); } };
window.deleteTag = async tag => {
  if (!confirm(`确定删除标签“${tag}”吗？它会从所有站点中移除。`)) return;
  await api(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
  if (activeFilter === tag) activeFilter = '';
  await load();
};
window.removeAccount = async id => { if (confirm('确定删除这个站点？')) { await api(`/api/accounts/${id}`, { method: 'DELETE' }); load(); } };
async function runBatch(action, button) {
  const targets = activeFilter ? accounts.filter(account => (account.tags || []).includes(activeFilter)) : [...accounts];
  if (!targets.length) return alert('当前筛选下没有可执行的站点。');
  const original = button.textContent; let ok = 0; let failed = 0; button.disabled = true;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const account = targets[index];
      button.textContent = `${index + 1}/${targets.length} ${account.name}`;
      $('#batchProgress').textContent = `正在${action === 'checkin' ? '签到' : '刷新'} ${index + 1}/${targets.length}：${account.name}`;
      try { const result = await api(`/api/accounts/${account.id}/${action}`, { method: 'POST' }); result.lastStatus === 'error' ? failed += 1 : ok += 1; }
      catch { failed += 1; }
    }
    $('#batchProgress').textContent = `执行完成：成功 ${ok} 个，失败 ${failed} 个。`;
    await load();
  } finally { button.disabled = false; button.textContent = original; }
}
$('#pollAll').onclick = event => runBatch('poll', event.currentTarget);
$('#checkinAll').onclick = event => runBatch('checkin', event.currentTarget);
load();
