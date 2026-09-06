# Adapter System（站点适配器）

Checkin Hub 通过适配器接入不同网站。支持一个站点 = 新增一个适配器文件 + 一份测试，**不需要改动 runner.js 或任何核心文件**。

## 三种接入层级

| 层级 | 说明 |
| --- | --- |
| 原生识别 | New API / One API（`adapters/new-api.js`、`adapters/one-api.js`）与自定义 JSON API（`adapters/generic-json.js`），开箱即用 |
| Adapter 识别 | 针对具体站点/网站家族的适配器，自动识别站点、登录态、用户信息、余额、签到状态并执行签到 |
| 通用探测 | 未识别站点只做只读 GET 探测（`adapters/discovery.js`），输出“可能可适配”的候选接口；**绝不执行未知写请求，也不代表自动支持** |

已知 Adapter 可直接使用；未知网站需要适配或人工确认。

## 统一接口

每个适配器导出：

```js
{
  id,            // 唯一 id
  name,          // 展示名
  auth,          // 'cookie' | 'bearer' | 'header' | 'none' | 'configurable'
  match(ctx),    // 只读识别，返回 { score, reason }；score 0-100
  detect(ctx),   // 只读，站点元信息
  getUser(ctx), getBalance(ctx), getCheckinStatus(ctx),
  checkin(ctx),  // 唯一允许的写操作；扫描阶段绝不调用
  run(ctx, account, action)  // 定时任务入口：'poll' | 'checkin'
}
```

`match()` 依据只读探测的**响应特征**评分（JSON 字段、状态码），hostname 只能作辅助。注册表选择最高分适配器；最高分并列返回 `ambiguous`（不盲选）；所有分数低于阈值返回 `unknown`。

## Adapter Context

所有请求必须经过 `adapters/context.js` 提供的 `ctx.fetchJson(path, options)` / `ctx.fetchText(...)`：

- 强制走 `safeUrl()`：HTTPS 限制 + SSRF 内网防护 + 超时 + redirect 限制
- 按适配器声明自动注入鉴权头
- `dryRun` 上下文会直接拦截一切非 GET/HEAD/OPTIONS 请求

适配器**不允许 import 原生 fetch 绕过安全层**。

## 新增一个站点

### 方式 A：声明式适配器（简单 JSON API，推荐首选）

在 `adapters/declarative/` 放一个 JSON 文件（参考 `example-site.json.example`）：

```json
{
  "id": "example-site",
  "name": "示例站",
  "match": { "statusPath": "/api/status", "jsonContains": ["site_name"] },
  "auth": "cookie",
  "balance": { "path": "/api/user", "field": "data.points" },
  "checkinStatus": { "path": "/api/checkin/status", "field": "data.checked" },
  "checkin": { "path": "/api/checkin", "method": "POST" }
}
```

重启后自动注册。配置会经过 schema 校验（`adapters/declarative.js` 的 `validateDeclarative`），无效配置会被跳过并告警。

### 方式 B：Code Adapter（复杂站点）

复制 `examples/template.js` 为 `adapters/<site-id>.js`，实现接口并在文件末尾导出。注册：在内置列表（`adapters/registry.js`）加入你的适配器，或提供 `registerAdapter()` 调用。

### 无论哪种方式，都要配一份测试

至少覆盖：`match` 评分命中/不命中、余额读取、签到成功与“已签到”分类、dry-run 下写请求被拦截。参考 `test/adapters.test.js`、`test/declarative.test.js`。

## 识别与发现

- 服务端提供 `POST /api/discover`（管理员）：对任意站点做只读 GET 探测 + 适配器评分，输出候选接口与置信度，供编写适配器参考。
- 浏览器扩展对未识别站点同样只做只读发现探测，结果标记为 `Unknown Site · 需要人工确认/添加适配器`。

## 失败分类

签到/轮询失败会归类为：`auth_expired`（登录失效）、`endpoint_changed`（接口变更）、`rate_limited`（限流）、`already_checked`、`network_error`、`unsupported`、`unknown`，见 `adapters/failures.js`。日志与账号卡片显示分类原因。
