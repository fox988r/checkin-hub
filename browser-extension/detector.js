// 站点识别与去重的纯函数模块：不依赖任何浏览器 API，可在 Node 测试中直接 import。

const NUMERIC_ID = /^\d{1,20}$/;

export function dedupeOrigins(tabs, hubUrl = '') {
  let hubOrigin = '';
  try { hubOrigin = new URL(hubUrl).origin; } catch {}
  const seen = new Map();
  const skipped = [];
  for (const tab of tabs || []) {
    let url;
    try { url = new URL(tab.url || ''); } catch { if (tab.url) skipped.push(tab.url); continue; }
    if (!/^https?:$/.test(url.protocol)) { skipped.push(tab.url); continue; }
    const origin = url.origin;
    if (!origin || origin === hubOrigin) { skipped.push(tab.url); continue; }
    if (!seen.has(origin)) seen.set(origin, { origin, tabId: tab.id, url: tab.url });
  }
  return { targets: [...seen.values()], skipped };
}

export function pickUserIdCandidates(storage) {
  const found = [];
  const scan = entries => {
    for (const [key, value] of entries || []) {
      if (typeof value !== 'string') continue;
      if (NUMERIC_ID.test(value) && /user|uid|account/i.test(key)) found.push(value);
      if (/user|account/i.test(key) && value.startsWith('{')) {
        try {
          const obj = JSON.parse(value);
          for (const field of ['id', 'user_id', 'userId', 'ID', 'Id']) {
            const candidate = obj?.[field];
            if ((typeof candidate === 'number' || typeof candidate === 'string') && NUMERIC_ID.test(String(candidate))) found.push(String(candidate));
          }
        } catch {}
      }
    }
  };
  scan(storage?.localStorage);
  scan(storage?.sessionStorage);
  return [...new Set(found)].slice(0, 5);
}

function isPanelStatus(status) {
  if (!status || status.status !== 200 || !status.data || typeof status.data !== 'object') return false;
  const data = status.data.data;
  return Boolean(data && typeof data === 'object' && ['system_name', 'version', 'start_time', 'quota_per_unit'].some(key => key in data));
}

function findConfig(data, names) {
  if (!data || typeof data !== 'object') return undefined;
  for (const name of names) if (data[name] !== undefined) return data[name];
  for (const value of Object.values(data)) {
    const found = findConfig(value, names);
    if (found !== undefined) return found;
  }
}

export function formatBalance(quota, statusData) {
  const amount = Number(quota);
  if (!Number.isFinite(amount)) return '—';
  const perUnit = Number(findConfig(statusData, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  const displayType = String(findConfig(statusData, ['quota_display_type', 'quotaDisplayType']) || 'USD').toUpperCase();
  const usd = amount / perUnit;
  if (displayType === 'CNY') return `¥${(usd * (Number(findConfig(statusData, ['usd_exchange_rate', 'usdExchangeRate'])) || 7.2)).toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

export function cleanSiteName(title = '', origin = '') {
  const cleaned = String(title).replace(/\s*[-–|·]\s*(New API|One API|New-API|Veloera|VoAPI).*$/i, '').trim();
  if (cleaned) return cleaned.slice(0, 40);
  try { return new URL(origin).hostname; } catch { return origin; }
}

export function readCheckinSupport(checkinProbe, statusData) {
  const hint = JSON.stringify(statusData || {}).match(/"(checkin[_-]?enabled|checkinEnabled|sign[_-]?in[_-]?enabled)"\s*:\s*(true|1)/i);
  if (hint) return true;
  if (!checkinProbe) return null;
  if (checkinProbe.status === 200 && checkinProbe.data && typeof checkinProbe.data === 'object') {
    if (checkinProbe.data.success === false && checkinProbe.data.message && !/未登录|登录/i.test(checkinProbe.data.message)) return true;
    return true;
  }
  if ([401, 403, 405].includes(checkinProbe.status)) return true;
  return null;
}

export function detectSite(probe) {
  const result = {
    origin: probe.origin, name: cleanSiteName(probe.title, probe.origin),
    panelType: 'unsupported', loggedIn: false, userId: probe.userId || '',
    balance: null, checkinSupported: null, status: 'unsupported', error: '', importable: false
  };
  const statusIsPanel = isPanelStatus(probe.status);
  const selfData = probe.self?.data?.data;
  const selfIsUser = probe.self?.status === 200 && selfData && typeof selfData === 'object' && (selfData.id !== undefined || selfData.quota !== undefined || selfData.username !== undefined);
  if (!statusIsPanel && !selfIsUser) {
    result.status = 'unsupported';
    result.error = '未发现 New API / One API 特征（/api/status 与 /api/user/self 均不可识别）';
    return result;
  }
  result.panelType = 'newapi';
  if (!selfIsUser) {
    if ([401, 403].includes(probe.self?.status)) {
      const triedCandidates = Boolean(probe.candidates?.length);
      result.status = triedCandidates ? 'unauthenticated' : 'missing-user-id';
      result.error = triedCandidates
        ? '面板已识别，但当前浏览器登录态无效或已过期'
        : '已识别面板，但未自动找到用户 ID（也可能未登录），可手动补填数字 ID';
    } else {
      result.status = 'error';
      result.error = `读取用户信息失败：${probe.self?.error || `HTTP ${probe.self?.status}`}`;
    }
    result.checkinSupported = readCheckinSupport(probe.checkin, probe.status?.data);
    return result;
  }
  result.loggedIn = true;
  result.status = 'ok';
  if (NUMERIC_ID.test(String(selfData.id ?? ''))) result.userId = String(selfData.id);
  if (!result.userId) {
    result.status = 'missing-user-id';
    result.importable = false;
  } else {
    result.importable = true;
  }
  result.balance = formatBalance(selfData.quota, probe.status?.data);
  result.checkinSupported = readCheckinSupport(probe.checkin, probe.status?.data);
  return result;
}

export function describeSite(site) {
  const panelLabel = site.panelType === 'newapi' ? 'New API / One API' : '非支持站点';
  const checkin = site.checkinSupported === true ? '可签到' : site.checkinSupported === null ? '签到接口未确认' : '不可签到';
  const balance = site.balance ? ` · 余额 ${site.balance}` : '';
  if (site.status === 'ok') return `${panelLabel} · 已登录 · ${checkin}${balance}`;
  if (site.status === 'missing-user-id') return `${panelLabel} · 已登录 · 未自动找到用户 ID，请补填`;
  if (site.status === 'unauthenticated') return `${panelLabel} · 未登录或登录已过期`;
  if (site.status === 'error') return `${panelLabel} · 探测失败：${site.error}`;
  return '非支持站点';
}

export function summarizeScan(targets) {
  return {
    total: targets.length,
    supported: targets.filter(site => site.panelType === 'newapi').length,
    importable: targets.filter(site => site.importable).length
  };
}
