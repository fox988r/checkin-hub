# Checkin Hub

**Self-hosted multi-site check-in & points manager.**

一个自托管的多站点签到、积分与余额管理工具。

> 📷 截图位：后台总览（站点卡片 · 余额 · 签到状态）
>
> 📷 截图位：浏览器扩展扫描结果列表
>
> 📷 截图位：调用统计

**目录**：[Why this exists](#why-this-exists) · [兼容范围](#兼容范围务必先读) · [Adapter 系统](#adapter-系统site-适配器) · [功能介绍](#功能介绍) · [安全边界](#安全边界) · [快速部署](#快速部署) · [浏览器扩展](#浏览器扩展使用) · [新站点接入指南](#新站点接入指南) · [致谢与署名](#致谢与署名)

---

## Why this exists

The author was too lazy to open a pile of API relay sites every day just to click "check in".

So she built a dashboard to collect them, auto-check in, track balances, and even import already logged-in sites from the browser.

Then, after finishing it, she realized she was also too lazy to actually use it.

So now it's open source.

---

项目的起因很简单：作者懒得每天打开一堆中转站签到。

于是决定做一个自动签到工具。

做完以后，作者发现自己连这个工具也懒得用。

所以开源了。

## 兼容范围（务必先读）

本 Hub 的能力边界是诚实的，不夸大兼容：

- ✅ **已知 Adapter 可直接使用**：New API / One API 及其兼容分支面板是一等公民（`/api/user/self` 余额、`/api/user/checkin` 签到、`Cookie + New-Api-User` 鉴权），开箱即用；自定义 JSON API 适配器覆盖任何"有接口就能配"的站点。
- ⚙️ **未知网站需要适配或人工确认**：没有现成适配器的站点，只有当它存在可调用的余额 / 签到 HTTP 接口、且你按[新站点接入指南](#新站点接入指南)完成适配后才被支持。通用探测只能给出"可能可适配"的候选接口线索，**不代表自动支持**。
- ❌ **明确不支持**：没有可调用接口、只能网页点击、依赖验证码 / Turnstile / 站点风控的站点。本项目不模拟浏览器行为绕过任何站点防护（服务器浏览器仅用于在站点自身规则允许的范围内续期登录态）。

## Adapter 系统（站点适配器）

不同网站通过独立的 adapter 接入，而不是把每个站点的逻辑硬编码进核心调度器：

```text
打开标签页 / 添加站点
  → 收集安全上下文
  → Adapter Registry 并发执行 match() 评分
  → 选最高分适配器（同分 → ambiguous，交人工确认；分数过低 → unknown）
  → getUser / getBalance / getCheckinStatus（只读）
  → checkin（唯一写操作，仅由手动签到或定时任务触发）
```

三种接入层级：

1. **原生识别**：New API、One API、自定义 JSON API。
2. **Adapter 识别**：针对具体网站/家族的适配器，自动知道如何判断登录、获取用户信息与余额、识别今日是否已签到、执行签到、使用哪种鉴权。
3. **通用探测（Generic Discovery）**：对未知网站只做只读 GET 探测，检查常见路径（`/api/user`、`/api/me`、`/api/points`、`/api/checkin/status` 等）与页面已有线索，输出候选接口与置信度；**禁止 POST/PUT/PATCH/DELETE 任何未知接口**。

适配器分两类：

- **Code Adapter**：复杂站点用，参考 [`adapters/examples/template.js`](adapters/examples/template.js)。
- **Declarative Adapter**：简单 JSON API 只写一份 JSON（经 schema 校验），放到 `adapters/declarative/` 即自动注册。

新支持一个站点 = 新增一个 adapter 文件 + 一份测试，不改核心 runner。详见 [`adapters/README.md`](adapters/README.md)。

## 功能介绍

- **余额轮询**：按标签批量轮询，间隔可配（`POLL_INTERVAL_MINUTES`）。
- **每日定时签到**：到点自动为启用轮询的标签签到（`AUTO_CHECKIN_HOUR`），识别"已签到 / 成功 / 失败"。
- **失败分类**：签到/轮询失败明确归类为登录失效、接口变更、限流、网络错误、站点不支持等，日志与卡片显示具体原因，不再是一团模糊报错。
- **通知接口（预留）**：`notifiers/` 抽象 + generic webhook（`NOTIFY_WEBHOOK_URL`）。只在连续签到失败、登录失效、适配器失效、余额明显变化时通知；正常签到成功不打扰。
- **浏览器扩展一键导入**：自动识别已登录的 New API / One API 站点并收编，导入后适配器确认支持签到的站点自动加入「自动签到」队列（可在后台关闭）。
- **统一网关**：OpenAI 兼容 `/v1` 入口，按站点顺序自动切换真实模型，含调用统计。
- **Bearer 自动续期**：短期 Token 站点配置刷新接口 + 轮换 Cookie，401 自动重试；绑定登录 IP 的站点可选用服务器浏览器续期。
- **凭据加密**：所有 Cookie / Bearer / API Key 以 AES-256-GCM 加密存储。
- **公开邀请页**：`/invites.html` 只展示管理员设置的名称、标签与邀请链接。

## 安全边界

- 仅操作你自己拥有或明确授权的账户；不批量注册、不碰未授权账户。
- 不扫描浏览历史、不自动登录、不读取密码、不绕验证码、不绕 Turnstile、不绕风控。
- 不执行未知写接口：通用探测只读（GET/HEAD/OPTIONS），签到写操作只发给已确认的适配器端点。
- 仅允许 HTTPS 公网地址（本地开发例外），DNS 级 SSRF 内网防护，请求带超时与 redirect 限制。
- 扩展隐私红线：不读其他域 Cookie；Cookie 只在你确认导入时读取，且只发给你自己的积分台；凭据不进日志、不进 URL。
- 导入 Token 最小权限：只能调用 `/api/import/*`，服务端只存 SHA-256 哈希，可随时吊销。
- 验证失败不入库：导入的凭据先真实验证余额接口，通过才保存。

## 快速部署

### 本地运行

需要 Node.js 20+。

```powershell
$env:ADMIN_PASSWORD="换成你的管理密码"
$env:APP_SECRET="换成至少32位随机字符串"
$env:GATEWAY_API_KEY="换成客户端访问网关时使用的总Key"
npm install
npm start
```

打开 `http://localhost:8080`。修改 `APP_SECRET` 后，已保存凭据将无法解密。

### Zeabur（Docker）

1. 推到 GitHub，Zeabur 新建项目选择仓库，根目录 `Dockerfile` 自动识别。
2. 服务变量：`ADMIN_PASSWORD`、`APP_SECRET`（≥32 位随机）、`GATEWAY_API_KEY`、`POLL_INTERVAL_MINUTES=30`、`AUTO_CHECKIN_HOUR=8`、`TZ=Asia/Shanghai`。
3. **添加持久卷，挂载 `/data`**，否则重新部署后数据全部丢失。
4. Networking 绑定域名；健康检查 `https://<域名>/health`。

轮询由进程内定时器完成；为避免重复签到请只运行一个副本。

## 浏览器扩展使用

扩展位于 [`browser-extension/`](browser-extension/)（Manifest V3，Chrome / Edge / Firefox），详见 [browser-extension/README.md](browser-extension/README.md)。

1. 后台「浏览器导入」面板 → **生成导入 Token**（只显示一次）。
2. 加载扩展，填入积分台地址与 Token。
3. **扫描当前站点 / 扫描所有已打开标签页** → 每个站点显示适配器识别结果：
   - `✅ New API Adapter · 已登录 · 可签到 · 余额 $2.31`
   - `⚠️ Unknown Site · 发现疑似签到接口 · 需要人工确认/添加适配器`
4. 勾选 → **加入积分台**。未知站点不会自动签到，也不会被自动导入。

## 新站点接入指南

详见 [`adapters/README.md`](adapters/README.md)。要点：

1. 先抓包（F12 → Network）确认站点**真实存在**可调用的余额/签到接口；抓不到接口就是不支持。
2. 简单 JSON API → 写一份 declarative JSON；复杂站点 → 复制 `adapters/examples/template.js` 实现 Code Adapter。
3. 用 `POST /api/discover`（管理员）对站点做只读探测，获取候选接口与适配器评分。
4. 补一份适配器测试：match 评分、余额读取、签到分类、dry-run 拦截写请求。

## 统一网关

在每个站点中填写上游 API Key 并选定真实模型后，客户端配置：

```text
Base URL: https://你的域名.zeabur.app/v1
API Key: 你设置的 GATEWAY_API_KEY
Model: xiaoju-auto（也可填写任意非空名称）
```

支持 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 和 `/v1/embeddings`。任一上游失败自动尝试下一个站点；每次尝试写入运行日志（不保存请求正文）。左侧「调用统计」提供请求量、成功率、Token 用量与站点 / 模型 / 失败原因排行。

## 兼容与迁移

- 旧账号数据零迁移：只填了 `panelType` 的旧账号在运行时自动映射到对应适配器（`newapi → new-api`、`generic → generic-json`）。
- 已有账号、定时签到、统一网关、模型价格等功能全部继续可用。

## 致谢与署名

**Original project**: <https://github.com/chloemeadow0-code/api>

This project started as an enhanced fork and later evolved toward an adapter-driven multi-site check-in framework.

感谢上游原作者的原始实现。本分支在其基础上新增：浏览器扩展与导入 Token 通道、Adapter 系统（registry / declarative / discovery）、失败分类与通知骨架。

**Built by two silicon workers:**
**GLM-5.3-Flash & GPT-5.6 Sol**

**Supervised by one human who eventually decided she was too lazy to use it.**

**Product direction & final review: fox988r**

## License 说明

- 当前仓库包含基于上游项目的二次开发代码；上游未提供明确开源许可。
- 使用 / 再分发前请自行确认上游许可状态。
- 本项目新增代码的许可问题暂不单独声明，避免制造许可冲突。
- 仅用于你拥有或明确授权的账户；请遵守各站点的服务条款。
