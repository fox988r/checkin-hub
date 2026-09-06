// New API 原生适配器：由 runner.js 原有的 New API 执行逻辑迁移而来，
// 行为与迁移前保持一致（Cookie + New-Api-User 头、/api/user/self 余额、
// /api/user/checkin 签到、/api/status 汇率配置）。
import { call, classifyCheckin, findConfig, formatQuota, readRemainingQuota } from '../src/runner.js';

function isPanelStatus(status) {
  if (!status || status.status !== 200 || !status.data || typeof status.data !== 'object') return false;
  const data = status.data.data;
  return Boolean(data && typeof data === 'object' && ['system_name', 'version', 'start_time', 'quota_per_unit'].some(key => key in data));
}

const adapter = {
  id: 'new-api',
  name: 'New API',
  auth: 'cookie',
  // New API 与 One API 共用同一套账号接口，本适配器同时覆盖两者；
  // one-api.js 是同协议的低分适配器，避免同分歧义。
  family: ['new-api', 'one-api'],

  async match(ctx) {
    try {
      const status = await ctx.fetchJson('/api/status', { auth: false });
      if (isPanelStatus(status)) {
        return { score: 95, reason: 'matched /api/status panel shape (system_name/version/...)' };
      }
      return { score: 0, reason: '/api/status is not a New API panel shape' };
    } catch (error) {
      return { score: 0, reason: `probe failed: ${error.message}` };
    }
  },

  async detect(ctx) {
    const status = await ctx.fetchJson('/api/status', { auth: false }).catch(() => null);
    const data = status?.data?.data || {};
    return {
      name: String(data.system_name || ctx.baseUrl).slice(0, 60),
      version: data.version || '',
      quotaPerUnit: Number(findConfig(status?.data, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000,
      panelFamily: 'new-api'
    };
  },

  // 只读探测签到能力：绝不用 POST 触发签到。
  async getCheckinStatus(ctx) {
    const probe = await ctx.fetchJson('/api/user/checkin', { auth: true }).catch(() => ({ status: 0 }));
    if (probe.status === 200 && probe.data && typeof probe.data === 'object') {
      return { supported: true, checkedToday: null, evidence: 'checkin endpoint answered a read-only GET' };
    }
    if ([401, 403, 405].includes(probe.status)) {
      return { supported: true, checkedToday: null, evidence: `HTTP ${probe.status} implies the route exists` };
    }
    return { supported: null, checkedToday: null, evidence: `HTTP ${probe.status} is inconclusive; POST probe is forbidden` };
  },

  async getUser(ctx) {
    const self = await ctx.fetchJson('/api/user/self', { headers: { 'new-api-user': String(ctx.userId || '') } });
    if (self.status !== 200) throw new Error(self.data?.message || `HTTP ${self.status}`);
    return self.data?.data || null;
  },

  async getBalance(ctx, account) {
    let config = {};
    try { config = (await ctx.fetchJson('/api/status', { auth: false })).data; } catch {}
    const self = await ctx.fetchJson('/api/user/self', { headers: { 'new-api-user': String(ctx.userId || '') } });
    if (self.status !== 200) throw new Error(self.data?.message || `HTTP ${self.status}`);
    const rawBalance = readRemainingQuota(self.data);
    if (rawBalance === undefined) throw new Error(self.data?.message || '余额响应中没有 data.quota');
    const quotaPerUnit = Number(findConfig(config, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
    return { balance: formatQuota(rawBalance, config, account.currency || 'auto'), rawBalance, quotaPerUnit };
  },

  async checkin(ctx) {
    const data = await ctx.fetchJson('/api/user/checkin', { method: 'POST' });
    return classifyCheckin(data.data ?? data);
  },

  // 兼容层：与迁移前 runner.js 的 runNewApi 行为逐字一致，
  // 继续经由 runner 的 call()（safeUrl + SSRF 防护 + 401 判定）执行。
  async run(_ctx, account, action) {
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
};

export default adapter;
export { isPanelStatus };
