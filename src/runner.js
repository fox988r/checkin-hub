import dns from 'node:dns/promises';
import net from 'node:net';
import { decrypt, encrypt, mutateStore, readStore } from './store.js';
import { refreshInBrowser } from './browser.js';

const accountRunQueues = new Map();

export function serializeAccountRun(id, task) {
  const previous = accountRunQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  accountRunQueues.set(id, current);
  return current.finally(() => {
    if (accountRunQueues.get(id) === current) accountRunQueues.delete(id);
  });
}

function privateIp(ip) {
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('169.254.') || ip.startsWith('fc') || ip.startsWith('fd');
}

export async function safeUrl(base, endpoint) {
  const url = new URL(endpoint || '/', base);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.hostname === 'localhost')) {
    throw new Error('只允许 HTTPS 站点');
  }
  if (net.isIP(url.hostname) && privateIp(url.hostname)) throw new Error('不允许访问内网地址');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(x => privateIp(x.address))) throw new Error('站点解析到内网地址');
  return url;
}

export function valueAt(obj, dotted) {
  return dotted.split('.').reduce((v, k) => v?.[k], obj);
}

export function tokenFromRefresh(data) {
  if (!data || typeof data !== 'object') return '';
  for (const key of ['access_token', 'accessToken', 'token']) {
    if (typeof data[key] === 'string' && data[key]) return data[key].replace(/^Bearer\s+/i, '');
  }
  for (const value of Object.values(data)) {
    const found = tokenFromRefresh(value);
    if (found) return found;
  }
  return '';
}

export function refreshCookieFromHeaders(headers, fallback = '') {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  const match = values.join(',').match(/(?:^|[,;]\s*)(new_api_refresh=[^;,\s]+)/i);
  return match?.[1] || fallback;
}

async function refreshBearer(account) {
  if (account.authType !== 'bearer' || !account.refreshPath) return false;
  if (account.refreshMode === 'browser') {
    const data = await refreshInBrowser(account.baseUrl, account.refreshPath);
    const token = tokenFromRefresh(data);
    if (!token) throw new Error('服务器浏览器刷新成功，但响应中没有新的 Access Token');
    account.credential = encrypt(token);
    return true;
  }
  if (!account.refreshCookie) return false;
  const url = await safeUrl(account.baseUrl, account.refreshPath);
  const currentCookie = decrypt(account.refreshCookie);
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json, text/plain, */*', cookie: currentCookie, origin: account.baseUrl, referer: `${account.baseUrl}/` },
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`自动刷新失败：${data?.message || data?.error || `HTTP ${response.status}`} (HTTP ${response.status})`);
  const token = tokenFromRefresh(data) || String(response.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('刷新接口成功，但响应中没有新的 Access Token');
  account.credential = encrypt(token);
  account.refreshCookie = encrypt(refreshCookieFromHeaders(response.headers, currentCookie));
  return true;
}

export function isExpiredAuthentication(status, data) {
  const message = String(data?.error?.message || data?.error || data?.message || data?.msg || '');
  return status === 401 || status === 403 || /unauthorized|invalid\s+(access\s+)?token|not\s+logged\s+in|登录已?失效|未登录|请先登录/i.test(message);
}

export function isHtmlResponse(text, contentType = '') {
  return /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(text));
}

export async function call(account, endpoint, method, panelType = 'generic', retried = false) {
  const url = await safeUrl(account.baseUrl, endpoint);
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: `${account.baseUrl}/`,
    'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 Edg/136.0.0.0'
  };
  const token = decrypt(account.credential);
  if (panelType === 'newapi') {
    headers.cookie = token;
    headers['new-api-user'] = String(account.userId || '');
  } else if (panelType !== 'public') {
    if (account.authType === 'bearer') headers.authorization = `Bearer ${token}`;
    if (account.authType === 'cookie') headers.cookie = token;
    if (account.authType === 'header') headers[account.headerName || 'authorization'] = token;
  }
  const response = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {
    const html = isHtmlResponse(text, response.headers.get('content-type') || '');
    const loginRedirect = response.status >= 300 && response.status < 400;
    if ((html || loginRedirect) && !retried && panelType === 'generic' && await refreshBearer(account)) {
      return call(account, endpoint, method, panelType, true);
    }
    throw new Error(html ? `接口返回网页而不是 JSON (HTTP ${response.status})` : loginRedirect ? `接口重定向到登录页面 (HTTP ${response.status})` : text.slice(0, 200) || `接口没有返回 JSON (HTTP ${response.status})`);
  }
  if (isExpiredAuthentication(response.status, data) && !retried && panelType === 'generic' && await refreshBearer(account)) {
    return call(account, endpoint, method, panelType, true);
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.error || data?.message || data?.msg;
    throw new Error(message ? `${message} (HTTP ${response.status})` : `HTTP ${response.status}`);
  }
  return data;
}

export function formatNewApiQuota(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${(amount / 500000).toFixed(2)}` : '—';
}

function findConfig(data, names) {
  if (!data || typeof data !== 'object') return undefined;
  for (const name of names) if (data[name] !== undefined) return data[name];
  for (const value of Object.values(data)) {
    const found = findConfig(value, names);
    if (found !== undefined) return found;
  }
}

export function formatQuota(value, config = {}, preference = 'auto') {
  const quota = Number(value);
  if (!Number.isFinite(quota)) return '—';
  const quotaPerUnit = Number(findConfig(config, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  const configuredType = String(findConfig(config, ['quota_display_type', 'quotaDisplayType', 'QuotaDisplayType']) || 'USD').toUpperCase();
  const type = preference === 'auto' ? configuredType : String(preference).toUpperCase();
  if (type === 'TOKENS' || type === 'RAW') return Math.round(quota).toLocaleString('zh-CN');
  const usd = quota / quotaPerUnit;
  if (type === 'CNY') {
    const rate = Number(findConfig(config, ['usd_exchange_rate', 'usdExchangeRate', 'USDExchangeRate'])) || 7.2;
    return `¥${(usd * rate).toFixed(2)}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function readRemainingQuota(data) {
  const quota = Number(valueAt(data, 'data.quota'));
  const total = Number(valueAt(data, 'data.total_quota'));
  const used = Number(valueAt(data, 'data.used_quota'));
  if (Number.isFinite(quota) && quota > 0) return quota;
  if (Number.isFinite(total) && Number.isFinite(used) && total > used) return total - used;
  return Number.isFinite(quota) ? quota : undefined;
}

export function readConfiguredBalance(data, field = 'balance') {
  const configured = valueAt(data, field);
  if (configured !== undefined && configured !== null && configured !== '') return configured;
  return readRemainingQuota(data);
}

export function summarizeModelPrice(item, quotaPerUnit = 500000) {
  if (!item) throw new Error('定价列表中找不到这个模型');
  if (Number(item.quota_type) === 1) {
    const price = Number(item.model_price);
    if (!Number.isFinite(price)) throw new Error('该模型没有可用的按次价格');
    return { type: 'per_call', text: `$${price.toFixed(4)} / 次`, model: item.model_name };
  }
  const ratio = Number(item.model_ratio);
  const completion = Number(item.completion_ratio || 1);
  if (!Number.isFinite(ratio)) throw new Error('该模型没有可用的 Token 价格');
  const input = ratio * 1000000 / quotaPerUnit;
  const output = input * completion;
  return { type: 'tokens', text: `输入 $${input.toFixed(4)} / 1M · 输出 $${output.toFixed(4)} / 1M`, model: item.model_name };
}

export function pricingAuthType(account) {
  return account.panelType === 'generic' ? 'generic' : 'newapi';
}

export function pricingRequestAccount(account) {
  return account.pricingCookie ? { ...account, authType: 'cookie', credential: account.pricingCookie } : account;
}

export function modelCategory(name) {
  const value = String(name).toLowerCase();
  if (/gemini/.test(value)) return 'Gemini';
  if (/gemma/.test(value)) return 'Gemma';
  if (/claude/.test(value)) return 'Claude';
  if (/deepseek/.test(value)) return 'DeepSeek';
  if (/qwen|qwq/.test(value)) return 'Qwen';
  if (/gpt|(^|[-_])o[134]([\-_.]|$)/.test(value)) return 'GPT';
  if (/grok/.test(value)) return 'Grok';
  if (/(^|[/_-])glm([/_.-]|$)|zai-org|z-ai/.test(value)) return 'GLM';
  if (/kimi|moonshot/.test(value)) return 'Kimi';
  if (/mistral|mixtral|codestral|devstral|ministral/.test(value)) return 'Mistral';
  if (/minimax/.test(value)) return 'MiniMax';
  if (/nemotron|nvidia/.test(value)) return 'Nemotron';
  if (/stepfun|(^|[/_-])step[-_.]/.test(value)) return 'Step';
  if (/cohere|command-r|north-mini/.test(value)) return 'Cohere';
  if (/llama|meta\//.test(value)) return 'Llama';
  if (/sora|video|veo/.test(value)) return '视频';
  if (/image|dall-e|flux|midjourney/.test(value)) return '图像';
  return '其他';
}

export async function modelApiUrl(account, endpoint) {
  const base = String(account.modelBaseUrl || account.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('请填写模型 API 地址');
  const suffix = /\/v1$/i.test(base) ? String(endpoint).replace(/^\/v1/i, '') : endpoint;
  return safeUrl(`${base}/`, String(suffix).replace(/^\//, ''));
}

async function callApiKey(account, endpoint, options = {}) {
  if (!account.apiKey) throw new Error('请先填写该站 API Key');
  const url = await modelApiUrl(account, endpoint);
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { authorization: `Bearer ${decrypt(account.apiKey)}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'SitePointsHub/1.0' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs || 20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `模型接口 HTTP ${response.status}`);
  return data;
}

export function buildModelCatalog(modelsResponse, pricingResponse, quotaPerUnit = 500000) {
  const available = new Set((modelsResponse?.data || []).map(x => typeof x === 'string' ? x : x.id).filter(Boolean));
  const customPricing = Array.isArray(pricingResponse?.data?.models);
  const prices = customPricing
    ? pricingResponse.data.models.map(x => ({
      model_name: x.name,
      quota_type: x.quotaType,
      price_type: x.priceType,
      model_price: x.priceValue,
      price_label: x.priceLabel,
      price_unit: 'quota'
    }))
    : Array.isArray(pricingResponse?.data) ? pricingResponse.data : Array.isArray(pricingResponse) ? pricingResponse : [];
  const priced = prices
    .filter(x => available.has(x.model_name))
    .map(x => {
      const perCall = Number(x.quota_type) === 1 || x.price_type === 'call';
      if (perCall) {
        if (!Number.isFinite(Number(x.model_price))) return null;
        return { name: x.model_name, category: modelCategory(x.model_name), billing: 'call', price: Number(x.model_price), priceUnit: x.price_unit || 'usd', text: x.price_label || `$${Number(x.model_price).toFixed(4)} / 次` };
      }
      if (x.price_label) return { name: x.model_name, category: modelCategory(x.model_name), billing: 'token', price: Number(x.model_price), text: x.price_label };
      const ratio = Number(x.model_ratio);
      if (!Number.isFinite(ratio)) return null;
      const input = ratio * 1000000 / quotaPerUnit;
      const output = input * Number(x.completion_ratio || 1);
      return { name: x.model_name, category: modelCategory(x.model_name), billing: 'token', price: ratio, text: `输入 $${input.toFixed(4)} / 1M · 输出 $${output.toFixed(4)} / 1M` };
    })
    .filter(Boolean);
  const pricedNames = new Set(priced.map(model => model.name));
  const unpriced = [...available]
    .filter(name => !pricedNames.has(name))
    .map(name => ({ name, category: modelCategory(name), billing: 'token', price: null, text: '价格未知 · 可正常选择和测试' }));
  return [...priced, ...unpriced].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function hasModelPricing(response) {
  const list = Array.isArray(response?.data?.models) ? response.data.models : Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  return list.some(item => item && typeof item === 'object' && (item.model_price !== undefined || item.model_ratio !== undefined || item.quota_type !== undefined || item.priceValue !== undefined || item.priceLabel !== undefined));
}

export function modelsFromPricing(response) {
  const list = Array.isArray(response?.data?.models) ? response.data.models : Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  return { data: list.map(item => ({ id: item?.model_name || item?.name })).filter(item => item.id) };
}

async function loadModelPricing(account, auth) {
  const paths = ['/api/pricing', '/api/models/pricing', '/api/models']; const errors = [];
  for (const path of paths) {
    try {
      const response = await call(account, path, 'GET', auth);
      if (hasModelPricing(response)) return response;
      errors.push(`${path}: JSON 中没有价格字段`);
    } catch (error) { errors.push(`${path}: ${error.message}`); }
  }
  throw new Error(`没有找到可用的模型价格接口。已尝试：${errors.join('；')}`);
}

export function estimateRemainingCalls(balanceRaw, model, quotaPerUnit = 500000) {
  if (!model || model.billing !== 'call') return null;
  const price = Number(model.price);
  if (price === 0) return 'unlimited';
  if (balanceRaw === null || balanceRaw === undefined || balanceRaw === '') return null;
  const balance = Number(balanceRaw);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(balance)) return null;
  const available = model.priceUnit === 'quota' ? balance : balance / (Number(quotaPerUnit) || 500000);
  return Math.max(0, Math.floor(available / price));
}

export function estimateAccountCalls(account, model) {
  const direct = estimateRemainingCalls(account?.balanceRaw, model, account?.quotaPerUnit);
  if (direct !== null) return direct;
  const shown = String(account?.balance ?? '').replace(/,/g, '');
  const amount = Number(shown.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(amount)) return null;
  const quotaPerUnit = Number(account?.quotaPerUnit) || 500000;
  if (model?.priceUnit === 'quota') {
    if (shown.includes('$')) return estimateRemainingCalls(amount * quotaPerUnit, model, quotaPerUnit);
    if (shown.includes('¥')) return null;
    if (account?.currency === 'raw' || account?.currency === 'tokens') return estimateRemainingCalls(amount, model, quotaPerUnit);
    return estimateRemainingCalls(amount * quotaPerUnit, model, quotaPerUnit);
  }
  if (model?.priceUnit === 'usd' && (shown.includes('$') || account?.currency === 'usd')) {
    return estimateRemainingCalls(amount * quotaPerUnit, model, quotaPerUnit);
  }
  return null;
}

export function buildPerCallCatalog(modelsResponse, pricingResponse) {
  return buildModelCatalog(modelsResponse, pricingResponse).filter(x => x.billing === 'call').map(({ billing, ...x }) => x);
}

async function refreshModelCatalogUnlocked(id) {
  const db = readStore(); const account = db.accounts.find(x => x.id === id);
  if (!account) throw new Error('账户不存在');
  const pricingAccount = pricingRequestAccount(account); const auth = pricingAuthType(pricingAccount);
  let models = null; let modelsError = '';
  try { models = await callApiKey(account, '/v1/models'); }
  catch (error) { modelsError = error.message; }
  let pricing = { data: [] };
  try {
    pricing = await loadModelPricing(pricingAccount, auth);
    account.modelPricingError = '';
  } catch (error) {
    account.modelPricingError = error.message;
  }
  if (!models) models = modelsFromPricing(pricing);
  if (!models.data?.length) throw new Error(`无法拉取模型：${modelsError || '模型列表和价格列表均为空'}`);
  let status = {};
  try { status = await call(account, '/api/status', 'GET', 'public'); } catch {}
  const quotaPerUnit = Number(findConfig(status, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  account.quotaPerUnit = quotaPerUnit;
  account.models = buildModelCatalog(models, pricing, quotaPerUnit).map(model => ({
    ...model,
    estimatedCalls: estimateAccountCalls(account, model)
  }));
  account.modelsCheckedAt = new Date().toISOString();
  mutateStore(latest => {
    const saved = latest.accounts.find(x => x.id === id);
    if (!saved) return;
    saved.quotaPerUnit = account.quotaPerUnit;
    saved.models = account.models;
    saved.modelsCheckedAt = account.modelsCheckedAt;
    saved.modelPricingError = account.modelPricingError;
  });
  return account.models;
}

export function refreshModelCatalog(id) {
  return serializeAccountRun(id, () => refreshModelCatalogUnlocked(id));
}

export async function testModelConnection(id) {
  const db = readStore();
  const account = db.accounts.find(x => x.id === id);
  if (!account) throw new Error('账户不存在');
  if (!account.modelName) throw new Error('请先选择一个模型');
  const started = Date.now();
  const result = await callApiKey(account, '/v1/chat/completions', {
    method: 'POST',
    body: { model: account.modelName, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
    timeoutMs: 60000
  });
  if (!result?.choices?.length) throw new Error(result?.message || '模型没有返回有效结果');
  return { ok: true, model: account.modelName, latencyMs: Date.now() - started, usage: result.usage || null };
}

async function refreshModelPriceUnlocked(id) {
  const db = readStore();
  const account = db.accounts.find(x => x.id === id);
  if (!account) throw new Error('账户不存在');
  if (!account.modelName) throw new Error('请先填写模型名称');
  const pricingAccount = pricingRequestAccount(account); const pricingAuth = pricingAuthType(pricingAccount);
  const [pricing, status] = await Promise.all([
    loadModelPricing(pricingAccount, pricingAuth),
    call(account, '/api/status', 'GET', 'public').catch(() => ({}))
  ]);
  const list = Array.isArray(pricing?.data) ? pricing.data : Array.isArray(pricing) ? pricing : [];
  const item = list.find(x => x.model_name === account.modelName);
  const quotaPerUnit = Number(findConfig(status, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  account.modelPrice = summarizeModelPrice(item, quotaPerUnit);
  account.modelPriceCheckedAt = new Date().toISOString();
  mutateStore(latest => {
    const saved = latest.accounts.find(x => x.id === id);
    if (!saved || saved.modelName !== account.modelName) return;
    saved.modelPrice = account.modelPrice;
    saved.modelPriceCheckedAt = account.modelPriceCheckedAt;
    saved.quotaPerUnit = quotaPerUnit;
  });
  return account.modelPrice;
}

export function refreshModelPrice(id) {
  return serializeAccountRun(id, () => refreshModelPriceUnlocked(id));
}

export function classifyCheckin(data) {
  const message = String(data?.message ?? data?.msg ?? '').trim();
  const already = /已签到|已经签到|重复签到|already\s*(checked|signed)|checked\s*in/i.test(message);
  if (already) return { status: 'already', message: message || '今日已签到' };
  if (data?.success === false || data?.ok === false || (typeof data?.code === 'number' && data.code !== 0 && data.code !== 200)) {
    throw new Error(message || '站点返回签到失败');
  }
  return { status: 'ok', message: message || '签到成功' };
}

async function runNewApi(account, action) {
  if (!account.userId) throw new Error('请填写用户 ID');
  if (!account.credential) throw new Error('请填写登录 Cookie');
  let checkin;
  if (action === 'checkin') checkin = classifyCheckin(await call(account, '/api/user/checkin', 'POST', 'newapi'));
  let config = {};
  try { config = await call(account, '/api/status', 'GET', 'public'); } catch {}
  const data = await call(account, '/api/user/self', 'GET', 'newapi');
  const rawBalance = readRemainingQuota(data);
  if (rawBalance === undefined) throw new Error(data?.message || '余额响应中没有 data.quota');
  const quotaPerUnit = Number(findConfig(config, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  return { balance: formatQuota(rawBalance, config, account.currency || 'auto'), rawBalance, quotaPerUnit, checkin };
}

async function runGeneric(account, action) {
  let checkin;
  if (action === 'checkin') {
    if (!account.checkinPath) throw new Error('尚未配置签到接口');
    checkin = classifyCheckin(await call(account, account.checkinPath, account.checkinMethod || 'POST'));
  }
  if (!account.balancePath) throw new Error('尚未配置余额接口；模型与价格功能仍可使用');
  const data = await call(account, account.balancePath, 'GET');
  const raw = readConfiguredBalance(data, account.balanceField || 'balance');
  if (raw === undefined) throw new Error(`余额字段 ${account.balanceField || 'balance'} 不存在`);
  const divisor = Number(account.balanceDivisor || 1);
  const amount = divisor !== 1 && Number.isFinite(Number(raw)) ? Number(raw) / divisor : raw;
  const prefix = account.currency === 'cny' ? '¥' : account.currency === 'usd' ? '$' : '';
  const balance = Number.isFinite(Number(amount)) ? `${prefix}${Number(amount).toFixed(2)}` : String(amount ?? '—');
  return { balance, rawBalance: Number.isFinite(Number(raw)) ? Number(raw) : null, quotaPerUnit: divisor || 1, checkin };
}

async function runAccountUnlocked(id, action = 'poll') {
  const db = readStore();
  const account = db.accounts.find(x => x.id === id);
  if (!account || !account.enabled) throw new Error('账户不存在或已停用');
  const originalCredential = account.credential;
  const originalRefreshCookie = account.refreshCookie;
  const startedAt = new Date().toISOString();
  let run;
  try {
    const panelType = account.panelType === 'generic' ? 'generic' : 'newapi';
    const result = panelType === 'newapi' ? await runNewApi(account, action) : await runGeneric(account, action);
    account.balance = result.balance;
    account.balanceRaw = result.rawBalance;
    account.quotaPerUnit = result.quotaPerUnit || account.quotaPerUnit || 500000;
    if (account.modelPrice?.type === 'per_call') {
      account.modelPrice.estimatedCalls = estimateAccountCalls(account, {
        billing: 'call', price: account.modelPrice.price, priceUnit: account.modelPrice.priceUnit
      });
    }
    account.detectedType = panelType;
    account.lastStatus = 'ok';
    account.lastError = '';
    account.lastCheckedAt = new Date().toISOString();
    if (action === 'checkin') {
      account.lastCheckinAt = account.lastCheckedAt;
      account.lastCheckinStatus = result.checkin.status;
      account.lastCheckinMessage = result.checkin.message;
    }
    run = { id: crypto.randomUUID(), accountId: id, action, status: result.checkin?.status || 'ok', message: result.checkin?.message || '', startedAt };
  } catch (error) {
    account.lastStatus = 'error';
    account.lastError = error.message;
    account.lastCheckedAt = new Date().toISOString();
    run = { id: crypto.randomUUID(), accountId: id, action, status: 'error', message: error.message, startedAt };
  }
  return mutateStore(latest => {
    const saved = latest.accounts.find(x => x.id === id);
    if (saved) {
      for (const field of ['balance', 'balanceRaw', 'quotaPerUnit', 'detectedType', 'lastStatus', 'lastError', 'lastCheckedAt', 'lastCheckinAt', 'lastCheckinStatus', 'lastCheckinMessage']) {
        if (Object.hasOwn(account, field)) saved[field] = account[field];
      }
      if (saved.modelPrice?.type === 'per_call') {
        saved.modelPrice.estimatedCalls = estimateAccountCalls(saved, {
          billing: 'call', price: saved.modelPrice.price, priceUnit: saved.modelPrice.priceUnit
        });
      }
      if (account.credential !== originalCredential && saved.credential === originalCredential) saved.credential = account.credential;
      if (account.refreshCookie !== originalRefreshCookie && saved.refreshCookie === originalRefreshCookie) saved.refreshCookie = account.refreshCookie;
    }
    latest.runs.unshift(run);
    latest.runs = latest.runs.slice(0, 5000);
    return saved || account;
  });
}

export function runAccount(id, action = 'poll') {
  return serializeAccountRun(id, () => runAccountUnlocked(id, action));
}

export function shouldPoll(account, pollTags = []) {
  const enabledTags = new Set(pollTags);
  return account.enabled && Array.isArray(account.tags) && account.tags.some(tag => enabledTags.has(tag));
}

export async function runAll(action = 'poll') {
  const db = readStore();
  const ids = db.accounts.filter(account => shouldPoll(account, db.pollTags || [])).map(x => x.id);
  const results = [];
  for (const id of ids) {
    try { results.push({ status: 'fulfilled', value: await runAccount(id, action) }); }
    catch (reason) { results.push({ status: 'rejected', reason }); }
  }
  return results;
}
