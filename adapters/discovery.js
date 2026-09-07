// 通用站点发现（Generic Discovery）：对未识别站点做只读、安全的路径探测。
// 硬性约束：只允许 GET/HEAD/OPTIONS；绝不 POST/PUT/PATCH/DELETE，
// 绝不自动点签到按钮或提交表单。输出只是“可能可适配”的候选信息，
// 供开发 adapter 参考，不代表自动支持。

const USER_PATHS = ['/api/user', '/api/user/self', '/api/me', '/api/profile', '/api/account'];
const BALANCE_PATHS = ['/api/points', '/api/balance', '/api/user/points', '/api/user/balance'];
const CHECKIN_PATHS = ['/api/checkin/status', '/api/signin/status', '/api/checkin', '/api/user/checkin'];

const USER_HINTS = ['id', 'user_id', 'userId', 'uid', 'username', 'email', 'nickname'];
const BALANCE_HINTS = ['points', 'balance', 'credit', 'quota', 'coin', 'coins', 'score', 'integral'];
const CHECKIN_HINTS = ['checkin', 'checked', 'sign_in', 'signed', 'signin', '签到'];

function jsonKeys(value, depth = 0, keys = new Set()) {
  if (depth > 3 || !value || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    jsonKeys(child, depth + 1, keys);
  }
  return keys;
}

function matchesHints(keys, hints) {
  return hints.some(hint => keys.has(hint.toLowerCase()));
}

export async function discoverSite(ctx, { perRequestTimeout = 15000 } = {}) {
  const methodsUsed = new Set();
  const probe = async path => {
    try {
      const result = await ctx.fetchJson(path, { auth: true });
      methodsUsed.add('GET');
      return result;
    } catch (error) {
      methodsUsed.add('GET');
      if (/dry-run/.test(error.message)) throw error;
      return { status: 0, data: null };
    }
  };

  const possibleUserEndpoints = [];
  const possibleBalanceEndpoints = [];
  const possibleCheckinEndpoints = [];

  for (const path of USER_PATHS) {
    const result = await probe(path);
    if (result.status === 200 && result.data && matchesHints(jsonKeys(result.data), USER_HINTS)) possibleUserEndpoints.push({ path, keys: [...jsonKeys(result.data)].slice(0, 8) });
  }
  for (const path of BALANCE_PATHS) {
    const result = await probe(path);
    if (result.status === 200 && result.data && matchesHints(jsonKeys(result.data), BALANCE_HINTS)) possibleBalanceEndpoints.push({ path, keys: [...jsonKeys(result.data)].slice(0, 8) });
  }
  for (const path of CHECKIN_PATHS) {
    const result = await probe(path);
    if (result.status === 200 && result.data && matchesHints(jsonKeys(result.data), CHECKIN_HINTS)) possibleCheckinEndpoints.push({ path, keys: [...jsonKeys(result.data)].slice(0, 8) });
    else if (result.status === 200) possibleCheckinEndpoints.push({ path, keys: [], note: '200 但响应字段不明确' });
  }

  const found = [possibleUserEndpoints.length, possibleBalanceEndpoints.length, possibleCheckinEndpoints.length].filter(Boolean).length;
  return {
    possibleUserEndpoints,
    possibleBalanceEndpoints,
    possibleCheckinEndpoints,
    confidence: Math.round(Math.min(1, found * 0.34) * 100) / 100,
    notes: [
      '仅执行了只读 GET 探测，未发送任何 POST/PUT/PATCH/DELETE',
      '候选结果仅供开发适配器参考，不代表该站点已被自动支持',
      ...(ctx.dryRun ? ['当前为 dry-run 模式，写请求已被上下文拦截'] : [])
    ],
    methodsUsed: [...methodsUsed]
  };
}
