// 签到/轮询失败统一分类：日志与 UI 依据 kind 显示明确原因，而不是一条含糊的 Error 文本。
const RULES = [
  ['already_checked', /已签到|已经签到|重复签到|already\s*(checked|signed)|checked\s*in/i],
  ['auth_expired', /HTTP 40[13]|未登录|登录已?失效|请先登录|Unauthorized|invalid\s+(access\s+)?token|无权进行此操作/i],
  ['rate_limited', /HTTP 429|过于频繁|rate\s*limit|太快/i],
  ['endpoint_changed', /HTTP 404|不存在|没有找到|没有配置|尚未配置/i],
  ['unsupported', /只允许 HTTPS|内网|不支持/i],
  ['network_error', /timeout|aborted|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|网络|解析/i]
];

export const FAILURE_KINDS = ['auth_expired', 'endpoint_changed', 'rate_limited', 'already_checked', 'network_error', 'unsupported', 'unknown'];

export function classifyFailure(error) {
  const message = String((error && (error.message || error)) || '');
  for (const [kind, pattern] of RULES) {
    if (pattern.test(message)) return kind;
  }
  return 'unknown';
}

export function describeFailureKind(kind) {
  return {
    auth_expired: '登录失效',
    endpoint_changed: '接口变更',
    rate_limited: '触发限流',
    already_checked: '已签到',
    network_error: '网络错误',
    unsupported: '站点不支持',
    unknown: '未知错误'
  }[kind] || '未知错误';
}
