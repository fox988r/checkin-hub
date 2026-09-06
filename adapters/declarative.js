// 声明式适配器：用一份经过 schema 校验的 JSON 描述一个简单站点，
// 不写任何 JS。文件放在 adapters/declarative/*.json 即自动注册。
//
// {
//   "id": "example-site",
//   "name": "示例站",
//   "match": { "statusPath": "/api/status", "jsonContains": ["site_name"] },
//   "auth": "cookie",
//   "balance": { "path": "/api/user", "field": "data.points", "divisor": 1 },
//   "checkinStatus": { "path": "/api/checkin/status", "field": "data.checked" },
//   "checkin": { "path": "/api/checkin", "method": "POST", "currency": "raw" }
// }

const AUTH_TYPES = new Set(['cookie', 'bearer', 'header', 'none']);
const METHODS = new Set(['GET', 'POST']);
const REQUIRED_TOP = ['id', 'auth', 'balance', 'checkin'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.startsWith('/');
}

export function validateDeclarative(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['配置必须是 JSON 对象'];
  for (const field of REQUIRED_TOP) {
    if (config[field] === undefined) errors.push(`缺少必填字段 ${field}`);
  }
  if (errors.length) return errors;
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(config.id))) errors.push('id 只允许小写字母、数字与连字符（2-41 位）');
  if (!AUTH_TYPES.has(config.auth)) errors.push(`auth 必须是 ${[...AUTH_TYPES].join(' / ')} 之一`);
  if (!isNonEmptyString(config.balance.path)) errors.push('balance.path 必须是以 / 开头的路径');
  if (typeof config.balance.field !== 'string' || !config.balance.field) errors.push('balance.field 必须是非空字符串');
  if (config.balance.divisor !== undefined && (!Number.isFinite(Number(config.balance.divisor)) || Number(config.balance.divisor) <= 0)) errors.push('balance.divisor 必须是正数');
  if (!isNonEmptyString(config.checkin.path)) errors.push('checkin.path 必须是以 / 开头的路径');
  const method = String(config.checkin.method || 'POST').toUpperCase();
  if (!METHODS.has(method)) errors.push('checkin.method 只允许 GET 或 POST');
  if (config.match !== undefined) {
    if (typeof config.match !== 'object') errors.push('match 必须是对象');
    else if (!isNonEmptyString(config.match.statusPath)) errors.push('match.statusPath 必须是以 / 开头的路径');
    else if (config.match.jsonContains !== undefined && (!Array.isArray(config.match.jsonContains) || !config.match.jsonContains.every(x => typeof x === 'string'))) errors.push('match.jsonContains 必须是字符串数组');
  }
  if (config.checkinStatus !== undefined) {
    if (!isNonEmptyString(config.checkinStatus.path)) errors.push('checkinStatus.path 必须是以 / 开头的路径');
    else if (typeof config.checkinStatus.field !== 'string' || !config.checkinStatus.field) errors.push('checkinStatus.field 必须是非空字符串');
  }
  return errors;
}

function valueAt(obj, dotted) {
  return String(dotted).split('.').reduce((value, key) => (value == null ? value : value[key]), obj);
}

export function buildDeclarativeAdapter(config) {
  const errors = validateDeclarative(config);
  if (errors.length) throw new Error(`声明式适配器配置无效：${errors.join('；')}`);
  const currencyPrefix = { cny: '¥', usd: '$' }[config.checkin?.currency || config.balance?.currency] || '';

  return {
    id: config.id,
    name: config.name || config.id,
    auth: config.auth,
    declarative: true,

    async match(ctx) {
      if (!config.match) return { score: 0, reason: 'no match rule; select explicitly via adapterId' };
      try {
        const status = await ctx.fetchJson(config.match.statusPath, { auth: false });
        const tokens = config.match.jsonContains || [];
        const text = JSON.stringify(status.data ?? {});
        const hits = tokens.filter(token => text.includes(token));
        if (status.status === 200 && (!tokens.length || hits.length)) {
          return { score: 90, reason: `matched ${config.match.statusPath}${hits.length ? ` via [${hits.join(', ')}]` : ''}` };
        }
        return { score: 0, reason: `${config.match.statusPath} did not match` };
      } catch (error) {
        return { score: 0, reason: `probe failed: ${error.message}` };
      }
    },

    async detect(ctx) {
      const status = config.match ? await ctx.fetchJson(config.match.statusPath, { auth: false }).catch(() => null) : null;
      return { name: config.name || config.id, quotaPerUnit: Number(config.balance?.divisor) || 1, panelFamily: config.id, statusData: status?.data ?? null };
    },

    async getBalance(ctx) {
      const response = await ctx.fetchJson(config.balance.path);
      if (response.status !== 200) throw new Error(`${config.balance.path} HTTP ${response.status}`);
      const raw = valueAt(response.data, config.balance.field);
      if (raw === undefined || raw === null || raw === '') throw new Error(`余额字段 ${config.balance.field} 不存在`);
      const divisor = Number(config.balance?.divisor) || 1;
      const amount = divisor !== 1 && Number.isFinite(Number(raw)) ? Number(raw) / divisor : raw;
      const balance = Number.isFinite(Number(amount)) ? `${currencyPrefix}${Number(amount).toFixed(2)}` : String(amount);
      return { balance, rawBalance: Number.isFinite(Number(raw)) ? Number(raw) : null, quotaPerUnit: divisor };
    },

    async getCheckinStatus(ctx) {
      if (!config.checkinStatus) return { supported: null, checkedToday: null, evidence: 'no checkinStatus config' };
      const response = await ctx.fetchJson(config.checkinStatus.path).catch(() => ({ status: 0 }));
      if (response.status !== 200) return { supported: null, checkedToday: null, evidence: `HTTP ${response.status}` };
      const checked = valueAt(response.data, config.checkinStatus.field);
      return { supported: true, checkedToday: Boolean(checked), evidence: `read ${config.checkinStatus.path}` };
    },

    async checkin(ctx) {
      const response = await ctx.fetchJson(config.checkin.path, { method: String(config.checkin.method || 'POST').toUpperCase() });
      const body = response.data ?? {};
      const message = String(body.message ?? body.msg ?? '').trim();
      if (/已签到|已经签到|重复签到|already/i.test(message)) return { status: 'already', message: message || '今日已签到' };
      if (body.success === false || body.ok === false) throw new Error(message || '站点返回签到失败');
      if (response.status >= 400) throw new Error(message || `HTTP ${response.status}`);
      return { status: 'ok', message: message || '签到成功' };
    }
  };
}
