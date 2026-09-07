# Checkin Hub

把散落在不同 AI/API 站点里的余额、签到和运行状态放到一个地方管理。

支持自动签到、余额查看、站点导入和多站点统一管理。
对于 New API / One API 类站点可以直接识别；其他站点可以通过 Adapter 接入。

---

## 为什么做这个

每天手动打开一堆中转站签到很烦，而且经常忘记哪个站还有余额、哪个站签到失败了。

原项目（[chloemeadow0-code/api](https://github.com/chloemeadow0-code/api)）已经提供了基础的站点积分管理能力，我在它的基础上继续补了浏览器导入、站点适配和失败诊断，让它更适合长期挂着自己用。

做完之后确实不再挨个开网站了。顺便开源。

## 相比原版，我改了什么

这个 fork 不是换个名字的搬运，主要改动都在"让更多站点能被管起来、出问题能看懂"这一层：

### 浏览器一键导入

不再要求手工复制一堆站点 Cookie 和用户 ID。对于支持的站点，浏览器扩展可以直接从已登录的页面识别站点信息，一键导入自己的 Hub。导入前服务端会先真实验证凭据，验证不过不入库。

### Adapter 站点适配体系

原版更多是固定的站点逻辑。现在把不同站点拆成独立的 Adapter：每个适配器自己知道怎么判断登录、读余额、识别签到状态、用什么鉴权。新支持一个站点 = 新增一个 adapter 文件 + 一份测试，不再往核心 runner 里堆 if/else。

### 未知站点只读探测

对没有适配器的网站可以做安全的只读探测（只发 GET/HEAD/OPTIONS），帮助判断它是否可能支持余额 / 签到接口。**不会对未知接口自动 POST 签到**——写操作只发给已确认的适配器端点。

### 更清楚的失败原因

签到或轮询失败时，明确归类为登录过期、接口变更、限流、已签到、网络错误、站点不支持等，卡片和日志直接显示具体原因，不再只显示一个模糊的"失败"。

### 自动签到标签

浏览器导入后，如果适配器确认站点支持签到，会自动给站点加上「自动签到」标签并加入轮询队列（可在后台关闭）。

### 通知接口

内置 webhook 通知（`NOTIFY_WEBHOOK_URL`）。只在连续签到失败、登录失效、适配器失效、余额明显变化时通知；正常签到成功不打扰。

### 原来就有、继续保留的能力

这些来自原项目，本 fork 全部保留并兼容：

- 多站点余额查看与轮询
- 手动 / 定时签到
- 运行日志
- 模型价格对比与降价提醒
- 调用统计
- OpenAI 兼容统一网关（`/v1`，多站点自动切换）
- 凭据加密存储

## 适合谁

- 自己有多个 AI API / 中转站账号
- 不想每天挨个打开网站签到
- 想统一看余额和签到状态
- 愿意自己部署一个轻量服务

## 快速开始

### 本地运行

需要 Node.js 20+。

```powershell
$env:ADMIN_PASSWORD="换成你的管理密码"
$env:APP_SECRET="换成至少32位随机字符串"
$env:GATEWAY_API_KEY="换成客户端访问网关时使用的总Key"
npm install
npm start
```

打开 `http://localhost:8080`。注意：修改 `APP_SECRET` 后，已保存的加密凭据将无法解密。

### Zeabur / Docker

1. Zeabur 新建项目选择本仓库，根目录 `Dockerfile` 自动识别。
2. 服务变量：`ADMIN_PASSWORD`、`APP_SECRET`（≥32 位随机）、`GATEWAY_API_KEY`。
3. **添加持久卷，挂载 `/data`**，否则重新部署后数据全部丢失。
4. Networking 绑定域名；健康检查 `https://<域名>/health`。

轮询由进程内定时器完成，为避免重复签到请只运行一个副本。

### 浏览器扩展（可选，推荐）

扩展位于 [`browser-extension/`](browser-extension/)（Manifest V3，Chrome / Edge / Firefox），详见 [browser-extension/README.md](browser-extension/README.md)。

1. 后台「浏览器导入」面板 → **生成导入 Token**（只显示一次）。
2. 加载扩展，填入 Hub 地址与 Token。
3. 扫描已打开的标签页 → 勾选支持的站点 → **一键导入**。

### 高级配置

以上之外的常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `POLL_INTERVAL_MINUTES` | 余额轮询间隔（分钟） |
| `AUTO_CHECKIN_HOUR` | 每日自动签到时间（小时） |
| `TZ` | 时区，如 `Asia/Shanghai` |
| `NOTIFY_WEBHOOK_URL` | webhook 通知地址 |

## 支持范围

- ✅ **New API / One API 及兼容面板**：原生支持，开箱即用。
- ✅ **自定义 JSON API**：可配置余额接口和字段，有接口就能配。
- ⚙️ **Adapter 扩展**：可以自己写适配器接入新站点（见下文）。
- 🔍 **未知站点**：只能只读探测，给出候选接口线索，不保证自动支持。
- ❌ **验证码 / Turnstile / 风控**：不会尝试绕过。依赖网页点击、没有可调用 HTTP 接口的站点不支持。

## 技术实现

想自己加站点或了解安全设计的话，看这里。

**Adapter Registry**：打开标签页或添加站点时，收集安全上下文后由 Registry 并发执行各适配器的 `match()` 评分，选最高分适配器；同分交人工确认，分数过低标记 unknown。适配器分两类：

- **Code Adapter**：复杂站点用，参考 [`adapters/examples/template.js`](adapters/examples/template.js)。
- **Declarative Adapter**：简单 JSON API 只写一份 JSON（经 schema 校验），放到 `adapters/declarative/` 即自动注册。

新站点接入步骤见 [`adapters/README.md`](adapters/README.md)：先抓包确认接口真实存在，再写适配器，可用管理员的 `POST /api/discover` 做只读探测。

**浏览器扩展**：探测在目标页面上下文内做同源请求，Cookie 不经过扩展；Cookie 只在你确认导入时通过 `chrome.cookies` 读取，且只发给你自己的 Hub。导入 Token 只能调用 `/api/import/*`，服务端只存 SHA-256 哈希，可随时吊销。

**安全边界**：仅操作你自己拥有或明确授权的账户；不扫浏览历史、不自动登录、不绕验证码 / Turnstile / 风控；仅允许 HTTPS 公网地址（本地开发例外），带 DNS 级 SSRF 内网防护、请求超时与 redirect 限制；所有 Cookie / Bearer / API Key 以 AES-256-GCM 加密存储。

**统一网关**：在各站点填上游 Key 并选定模型后，客户端直接把 Base URL 指到 Hub：

```text
Base URL: https://你的域名/v1
API Key: 你设置的 GATEWAY_API_KEY
Model: 任意非空名称（自动按站点顺序切换真实模型）
```

支持 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`，任一上游失败自动尝试下一个站点。

**兼容与迁移**：旧账号数据零迁移，只填了 `panelType` 的旧账号运行时自动映射到对应适配器（`newapi → new-api`、`generic → generic-json`）。

## 基于什么项目

本项目基于 [chloemeadow0-code/api](https://github.com/chloemeadow0-code/api) 进行二次开发，感谢原作者提供基础实现。

**License 说明**：上游未提供明确开源许可，因此本仓库不擅自添加新许可证，也不编造授权状态；使用 / 再分发前请自行确认上游许可状态。仅用于你拥有或明确授权的账户，请遵守各站点的服务条款。

---

**Product direction & final review: fox988r** · Built by two silicon workers: **GLM-5.3-Flash & GPT-5.6 Sol**
