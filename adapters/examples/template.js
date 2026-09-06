// ============================================================
// Code Adapter 模板：复制本文件为 adapters/<site-id>.js，
// 实现下列接口，并在测试里覆盖 match 评分与各方法即可接入新站点。
// ============================================================
//
// 硬性规则：
// 1. 适配器不允许 import 原生 fetch —— 所有远端请求必须经过
//    context.fetchJson / context.fetchText（内部走 safeUrl：HTTPS 限制、
//    SSRF 防护、超时、redirect 限制，dry-run 时拦截一切写请求）。
// 2. match()/detect()/getUser()/getBalance()/getCheckinStatus() 只读。
// 3. checkin() 是唯一允许的写操作，只在用户手动签到或定时任务时被调用；
//    扫描与导入验证阶段绝不调用它。
// 4. run(ctx, account, action) 是定时任务入口：action 为 'poll' 或 'checkin'，
//    返回 { balance, rawBalance, quotaPerUnit, checkin }（checkin 仅签到时存在）。
//
// match() 返回 { score, reason }：
//   - score 0-100，分数体现“这个站点是该适配器目标家族”的置信度
//   - 只能依据只读探测的响应特征（JSON 字段、状态码），hostname 只能作辅助
//   - 无法确认时返回 { score: 0, reason: '...' }，不要猜

export default {
  // 全局唯一 id（小写字母/数字/连字符），账号通过 adapterId 关联它
  id: 'example-site',
  // 展示名
  name: 'Example Site',
  // 鉴权方式声明：'cookie' | 'bearer' | 'header' | 'none' | 'configurable'
  auth: 'cookie',

  // 只读识别：判断当前站点是否为本适配器的目标
  async match(ctx) {
    const status = await ctx.fetchJson('/api/status', { auth: false }).catch(() => null);
    const data = status?.data?.data;
    if (status?.status === 200 && data && 'site_name' in data) {
      return { score: 90, reason: 'matched /api/status with site_name' };
    }
    return { score: 0, reason: '/api/status shape does not match' };
  },

  // 只读：返回站点元信息
  async detect(ctx) {
    const status = await ctx.fetchJson('/api/status', { auth: false }).catch(() => null);
    return { name: status?.data?.data?.site_name || this.name, quotaPerUnit: 1, panelFamily: this.id };
  },

  // 只读：用户信息；未登录时抛错
  async getUser(ctx) {
    const response = await ctx.fetchJson('/api/me');
    if (response.status !== 200) throw new Error(response.data?.message || `HTTP ${response.status}`);
    return response.data?.data || null;
  },

  // 只读：余额/积分；返回 { balance, rawBalance, quotaPerUnit }
  async getBalance(ctx, account) {
    const response = await ctx.fetchJson('/api/points');
    const raw = response.data?.data?.points;
    if (raw === undefined) throw new Error('余额字段 data.points 不存在');
    return { balance: String(raw), rawBalance: Number(raw), quotaPerUnit: 1 };
  },

  // 只读：签到状态；supported 使用 null 表示“无法在不产生写请求的前提下确认”
  async getCheckinStatus(ctx) {
    const response = await ctx.fetchJson('/api/checkin/status').catch(() => ({ status: 0 }));
    if (response.status !== 200) return { supported: null, checkedToday: null };
    return { supported: true, checkedToday: Boolean(response.data?.data?.checked) };
  },

  // 唯一允许的写操作
  async checkin(ctx) {
    const response = await ctx.fetchJson('/api/checkin', { method: 'POST' });
    const body = response.data ?? {};
    const message = String(body.message ?? '').trim();
    if (/已签到|already/i.test(message)) return { status: 'already', message: message || '今日已签到' };
    if (body.success === false) throw new Error(message || '站点返回签到失败');
    return { status: 'ok', message: message || '签到成功' };
  },

  // 定时任务/手动按钮入口（兼容层）
  async run(ctx, account, action) {
    let checkin;
    if (action === 'checkin') checkin = await this.checkin(ctx);
    const balance = await this.getBalance(ctx, account);
    return { ...balance, checkin };
  }
};
