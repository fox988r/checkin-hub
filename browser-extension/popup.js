import { dedupeOrigins, detectSite, describeSite } from './detector.js';

const $ = selector => document.querySelector(selector);

// ---- chrome API 兼容封装：Chrome / Firefox 都支持回调式调用 ----
function callApi(method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      method(...args, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(result);
      });
    } catch (error) { reject(error); }
  });
}

async function loadSettings() {
  const stored = await callApi(chrome.storage.local.get.bind(chrome.storage.local), ['hubUrl', 'importToken']);
  $('#hubUrl').value = stored.hubUrl || '';
  $('#importToken').value = stored.importToken || '';
  return { hubUrl: (stored.hubUrl || '').trim().replace(/\/+$/, ''), importToken: (stored.importToken || '').trim() };
}

async function saveSettings() {
  const hubUrl = $('#hubUrl').value.trim().replace(/\/+$/, '');
  const importToken = $('#importToken').value.trim();
  await callApi(chrome.storage.local.set.bind(chrome.storage.local), { hubUrl, importToken });
  return { hubUrl, importToken };
}

// ---- 页面内探测：在目标站点上下文执行，同源 fetch 自动携带 Cookie（含 httpOnly），
// Cookie 内容不会进入本扩展代码，也绝不打印到 console。 ----
function probeInPage(hubOrigin) {
  const NUMERIC = /^\d{1,20}$/;
  if (location.origin === hubOrigin) return { isHub: true, origin: location.origin };
  const storageEntries = () => {
    const collect = store => {
      const entries = [];
      try {
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          if (key) entries.push([key, store.getItem(key)]);
        }
      } catch {}
      return entries;
    };
    return { localStorage: collect(localStorage), sessionStorage: collect(sessionStorage) };
  };
  const candidatesFromStorage = entries => {
    const found = [];
    const push = value => { if (NUMERIC.test(String(value)) && !found.includes(String(value))) found.push(String(value)); };
    const scan = list => {
      for (const [key, value] of list || []) {
        if (typeof value !== 'string') continue;
        if (NUMERIC.test(value) && /user|uid|account/i.test(key)) push(value);
        if (/user|account/i.test(key) && value.startsWith('{')) {
          try {
            const obj = JSON.parse(value);
            for (const field of ['id', 'user_id', 'userId', 'ID', 'Id']) {
              const candidate = obj?.[field];
              if (typeof candidate === 'number' || typeof candidate === 'string') push(candidate);
            }
          } catch {}
        }
      }
    };
    scan(entries?.localStorage);
    scan(entries?.sessionStorage);
    return found.slice(0, 5);
  };
  const getJSON = async (path, headers = {}) => {
    try {
      const response = await fetch(path, { headers, credentials: 'include' });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { status: response.status, data };
    } catch (error) {
      return { status: 0, error: String((error && error.message) || error) };
    }
  };
  return (async () => {
    const status = await getJSON('/api/status');
    const candidates = candidatesFromStorage(storageEntries());
    const userId = candidates[0] || '';
    let self = await getJSON('/api/user/self', userId ? { 'new-api-user': userId } : {});
    if (self.status === 200 && NUMERIC.test(String(self.data?.data?.id ?? ''))) {
      candidates.unshift(String(self.data.data.id));
    } else if (self.status !== 200 && candidates.length > 1) {
      for (const candidate of candidates.slice(1)) {
        const retry = await getJSON('/api/user/self', { 'new-api-user': candidate });
        if (retry.status === 200) { self = retry; candidates.unshift(candidate); break; }
      }
    }
    const checkin = await getJSON('/api/user/checkin');
    return {
      origin: location.origin,
      title: String(document.title || '').slice(0, 80),
      status, self, checkin,
      userId: candidates[0] || '',
      candidates
    };
  })();
}

async function probeTab(tab) {
  const settings = await currentSettings();
  try {
    const [injection] = await callApi(chrome.scripting.executeScript.bind(chrome.scripting), {
      target: { tabId: tab.tabId ?? tab.id },
      func: probeInPage,
      args: [settings.hubUrl ? new URL(settings.hubUrl).origin : '']
    });
    const probe = injection?.result ?? injection;
    if (!probe) return { origin: tab.origin, error: '无法读取页面（可能被浏览器限制）', status: 'error' };
    if (probe.isHub) return null;
    return { ...detectSite(probe), candidates: probe.candidates || [] };
  } catch (error) {
    return { origin: tab.origin, panelType: 'unsupported', status: 'error', error: `页面探测失败：${error.message}`, loggedIn: false, importable: false, userId: '', balance: null, checkinSupported: null, name: tab.origin };
  }
}

async function scan(targets) {
  const results = [];
  let active = 0;
  const queue = [...targets];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const target = queue.shift();
      active += 1;
      $('#scanStatus').textContent = `正在扫描（并发 ${active}，剩余 ${queue.length}）：${target.origin}`;
      const site = await probeTab(target);
      active -= 1;
      if (site) results.push(site);
    }
  }));
  return results;
}

// ---- 结果渲染与导入 ----
const scanResults = new Map();
let settings = { hubUrl: '', importToken: '' };

function badge(site) {
  if (site.status === 'ok') return '<span class="badge ok">✅ 已登录</span>';
  if (site.status === 'missing-user-id') return '<span class="badge warn">⚠️ 缺用户 ID</span>';
  if (site.status === 'unauthenticated') return '<span class="badge bad">❌ 未登录</span>';
  if (site.status === 'error') return '<span class="badge bad">⚠️ 探测失败</span>';
  return '<span class="badge mute">— 非支持站点</span>';
}

function renderResults() {
  const items = [...scanResults.values()];
  $('#results').innerHTML = items.map((site, index) => `
    <div class="site" data-origin="${site.origin}">
      <div class="head">
        ${site.importable ? `<input type="checkbox" class="pick" data-origin="${site.origin}" checked>` : ''}
        <span class="name">${escapeHtml(site.name)}</span>
        <span class="origin">${escapeHtml(site.origin.replace(/^https?:\/\//, ''))}</span>
        ${badge(site)}
      </div>
      <p class="desc">${escapeHtml(describeSite(site))}</p>
      ${site.status === 'missing-user-id' ? `<div class="uid-row">用户 ID：<input type="text" class="uid-input" data-origin="${site.origin}" value="${escapeHtml(site.candidates?.[0] || '')}" placeholder="填数字 ID"></div>` : ''}
      ${site.error && site.status !== 'missing-user-id' ? `<p class="desc error">${escapeHtml(site.error)}</p>` : ''}
    </div>`).join('') || '<p class="hint">还没有扫描结果。</p>';
  document.querySelectorAll('.uid-input').forEach(input => {
    input.oninput = () => {
      const site = scanResults.get(input.dataset.origin);
      if (!site) return;
      site.userId = input.value.replace(/\D/g, '');
      site.importable = /^\d{1,20}$/.test(site.userId);
      refreshImportButton();
    };
  });
  document.querySelectorAll('.pick').forEach(box => { box.onchange = refreshImportButton; });
  refreshImportButton();
}

function selectedSites() {
  return [...document.querySelectorAll('.pick:checked')].map(box => scanResults.get(box.dataset.origin)).filter(Boolean);
}

function refreshImportButton() {
  const settingsReady = settings.hubUrl && settings.importToken;
  $('#importBtn').disabled = !(selectedSites().length && settingsReady);
  if (!settingsReady) $('#importStatus').textContent = '请先在「积分台连接设置」里填写地址与导入 Token。';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function hubFetch(path, options = {}) {
  const response = await fetch(`${settings.hubUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.importToken}`, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function importSelected() {
  const sites = selectedSites();
  $('#importBtn').disabled = true;
  for (const site of sites) {
    const origin = site.origin;
    try {
      const check = await hubFetch(`/api/import/check?baseUrl=${encodeURIComponent(origin)}`);
      if (check.status === 401) throw new Error('导入 Token 无效或已吊销，请到积分台后台重新生成');
      if (check.status !== 200) throw new Error(check.data.error || `检查失败 HTTP ${check.status}`);
      if (check.data.exists && !confirm(`${origin} 已在积分台（${check.data.name}）。\n是否覆盖它的登录态与用户 ID？`)) {
        $('#importStatus').textContent = `已跳过 ${origin}`;
        continue;
      }
      const cookies = await callApi(chrome.cookies.getAll.bind(chrome.cookies), { url: origin });
      const credential = (cookies || []).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      if (!credential) throw new Error('未读取到该站点的 Cookie（可能已被站点清除）');
      const response = await hubFetch('/api/import/account', {
        method: 'POST',
        body: JSON.stringify({ name: site.name, baseUrl: origin, panelType: site.panelType, userId: site.userId, credential, detectedBalance: site.balance, checkinSupported: site.checkinSupported })
      });
      if (response.status !== 200) throw new Error(response.data.error || `导入失败 HTTP ${response.status}`);
      const label = response.data.result === 'created' ? '已加入' : '已更新登录态';
      const balance = response.data.verification?.balance ? `，余额 ${response.data.verification.balance}` : '';
      $('#importStatus').textContent = `${site.name} ${label}${balance}`;
      site.imported = true;
      scanResults.delete(origin);
    } catch (error) {
      $('#importStatus').textContent = `${site.name} 导入失败：${error.message}`;
    }
  }
  renderResults();
}

async function runScan(kind) {
  $('#importStatus').textContent = '';
  scanResults.clear();
  if (!settings.hubUrl) { renderResults(); $('#scanStatus').textContent = '请先填写积分台地址。'; return; }
  $('#scanStatus').textContent = '正在读取标签页…';
  let tabs;
  if (kind === 'current') {
    const [active] = await callApi(chrome.tabs.query.bind(chrome.tabs), { active: true, currentWindow: true });
    tabs = active ? [active] : [];
  } else {
    tabs = await callApi(chrome.tabs.query.bind(chrome.tabs), {});
  }
  const { targets } = dedupeOrigins(tabs, settings.hubUrl);
  if (!targets.length) { $('#scanStatus').textContent = '没有可扫描的 http/https 标签页。'; renderResults(); return; }
  $('#scanStatus').textContent = `共 ${targets.length} 个站点待扫描…`;
  const sites = await scan(targets);
  for (const site of sites) scanResults.set(site.origin, site);
  const okCount = sites.filter(site => site.status === 'ok').length;
  $('#scanStatus').textContent = `扫描完成：${sites.length} 个站点，${okCount} 个已登录可用。`;
  renderResults();
}

$('#saveSettings').onclick = async () => {
  settings = await saveSettings();
  $('#settingsHint').textContent = settings.hubUrl ? `已保存：${settings.hubUrl}` : '请填写地址';
  refreshImportButton();
};
$('#scanCurrent').onclick = () => runScan('current');
$('#scanAll').onclick = () => runScan('all');
$('#importBtn').onclick = importSelected;

(async () => {
  settings = await loadSettings();
  if (settings.hubUrl) $('#settingsHint').textContent = `已保存：${settings.hubUrl}`;
  renderResults();
})();
