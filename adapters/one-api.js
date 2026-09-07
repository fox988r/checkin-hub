// One API 与 New API 共用同一套账号接口（/api/user/self、Cookie 鉴权），
// 服务端无法可靠区分二者。本适配器作为同协议家族的低分成员存在：
// 注册它是为了在 UI 与导入记录里明确“这是 One API 兼容面板”，
// 实际识别永远优先命中 new-api（95 > 92），不会产生同分歧义。
import newApi from './new-api.js';

const adapter = {
  ...newApi,
  id: 'one-api',
  name: 'One API',

  async match(ctx) {
    const result = await newApi.match(ctx);
    if (result.score > 0) return { score: result.score - 3, reason: `${result.reason} (One API family shares the same protocol)` };
    return result;
  },

  async detect(ctx) {
    const meta = await newApi.detect(ctx);
    return { ...meta, panelFamily: 'one-api' };
  }
};

export default adapter;
