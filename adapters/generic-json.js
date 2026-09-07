// 自定义 JSON API 适配器：由 runner.js 原有的 runGeneric 逻辑迁移而来，
// 行为与迁移前保持一致（balancePath/balanceField/balanceDivisor、
// checkinPath/checkinMethod、bearer/cookie/header 鉴权、401 自动续期）。
// 该适配器不由 match() 自动发现 —— 它由账号上已配置的字段显式选择。
import { call, classifyCheckin, readConfiguredBalance } from '../src/runner.js';

const adapter = {
  id: 'generic-json',
  name: '自定义 JSON API',
  auth: 'configurable',

  async match() {
    // 通用 JSON API 无法靠探测自动识别：字段由账号配置驱动。
    return { score: 0, reason: 'configured manually via account fields, not auto-detected' };
  },

  async getBalance(ctx, account) {
    if (!account.balancePath) throw new Error('尚未配置余额接口；模型与价格功能仍可使用');
    const response = await ctx.fetchJson(account.balancePath);
    const raw = readConfiguredBalance(response.data, account.balanceField || 'balance');
    if (raw === undefined) throw new Error(`余额字段 ${account.balanceField || 'balance'} 不存在`);
    const divisor = Number(account.balanceDivisor || 1);
    const amount = divisor !== 1 && Number.isFinite(Number(raw)) ? Number(raw) / divisor : raw;
    const prefix = account.currency === 'cny' ? '¥' : account.currency === 'usd' ? '$' : '';
    const balance = Number.isFinite(Number(amount)) ? `${prefix}${Number(amount).toFixed(2)}` : String(amount ?? '—');
    return { balance, rawBalance: Number.isFinite(Number(raw)) ? Number(raw) : null, quotaPerUnit: divisor || 1 };
  },

  async checkin(ctx, account) {
    if (!account.checkinPath) throw new Error('尚未配置签到接口');
    const data = await ctx.fetchJson(account.checkinPath, { method: account.checkinMethod || 'POST' });
    return classifyCheckin(data.data ?? data);
  },

  // 兼容层：与迁移前 runner.js 的 runGeneric 行为逐字一致。
  async run(_ctx, account, action) {
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
};

export default adapter;
