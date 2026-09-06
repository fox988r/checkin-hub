// 通知抽象骨架：暂不做大型通知系统，只提供统一注册与分发。
// 未来可挂 Telegram / Bark / ntfy / webhook 等实现。
// 设计原则：只在值得打扰时通知（连续签到失败、登录失效、适配器失效、
// 余额明显变化）；正常签到成功默认静默。发送失败绝不影响主流程。

const senders = new Map();

export function registerNotifier(id, send) {
  if (typeof send !== 'function') throw new Error('notifier send 必须是函数');
  senders.set(id, send);
  return [...senders.keys()];
}

export function unregisterNotifier(id) {
  senders.delete(id);
}

export function listNotifiers() {
  return [...senders.keys()];
}

export async function notify(event) {
  const results = [];
  for (const [id, send] of senders) {
    try {
      await send({ at: new Date().toISOString(), ...event });
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  return results;
}

// 便捷封装：通知永不抛错、永不阻塞主流程。
export function notifySafe(event) {
  return notify(event).catch(() => []);
}
