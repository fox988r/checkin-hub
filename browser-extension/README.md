# 站点积分台 · 收编助手（浏览器扩展）

把浏览器里**已经登录**的 New API / One API 站点一键扫描并导入自建积分台，免去手工复制 Cookie、用户 ID 和接口地址。

## 安装

### Chrome / Edge

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本目录（`browser-extension/`）。

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击「临时载入附加组件」，选择本目录下的 `manifest.json`。

## 使用

1. 在积分台后台网页「浏览器导入」面板点击「生成导入 Token」（只显示一次）。
2. 点击扩展图标，展开「积分台连接设置」，填入积分台地址和导入 Token 并保存。
3. 保持已登录的站点标签页打开，点击：
   - **扫描当前站点**：只探测当前活动标签页；
   - **扫描所有已打开标签页**：去重后探测所有 http/https 标签页。
4. 勾选要收编的站点（缺用户 ID 的可以当场补填），点击「加入积分台」。
5. 导入时扩展才会读取目标站点的 Cookie（含 httpOnly 的 `session`），并只发送给你自己的积分台。服务器会立即用该 Cookie 验证 `/api/user/self`，验证通过才保存。

## 隐私边界

- 不读取浏览历史，不扫描未打开的站点；只探测你主动点按钮时的当前标签页和已打开标签页。
- API 探测（`/api/status`、`/api/user/self`、`/api/user/checkin`）在目标站点页面上下文内同源发起，Cookie 不进入扩展代码。
- Cookie 只在点击「加入积分台」时读取，且只发给你在设置里填写的积分台地址（Bearer Token 鉴权）。
- 凭据不会打印到 console，不会放入 URL，不接任何第三方服务或统计。
- 扫描探测绝不发送 POST 到 `/api/user/checkin`，不会误触发签到。
