// Adapter Registry：注册内置与声明式适配器，按 match() 评分选最优。
// - score < minScore → unknown（未识别）
// - 最高分并列 → ambiguous（不盲选，交人工确认）
// - hostname 只能作为辅助信号，本注册表完全依据接口响应特征匹配。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import newApi from './new-api.js';
import oneApi from './one-api.js';
import genericJson from './generic-json.js';
import { buildDeclarativeAdapter } from './declarative.js';

const registry = new Map();
let declarativeLoaded = false;

export function registerAdapter(adapter) {
  if (!adapter?.id || typeof adapter.match !== 'function' || typeof adapter.run !== 'function') {
    throw new Error(`适配器 ${adapter?.id || '(未命名)'} 缺少 id/match/run 必备接口`);
  }
  registry.set(adapter.id, adapter);
  return adapter;
}

export function loadDeclarativeAdapters(dir) {
  const target = dir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'declarative');
  let loaded = [];
  let files = [];
  try { files = fs.existsSync(target) ? fs.readdirSync(target).filter(name => name.endsWith('.json')) : []; } catch {}
  for (const name of files) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(target, name), 'utf8'));
      loaded.push(registerAdapter(buildDeclarativeAdapter(config)));
    } catch (error) {
      console.warn(`[adapters] 跳过无效的声明式适配器 ${name}: ${error.message}`);
    }
  }
  declarativeLoaded = true;
  return loaded;
}

export function getRegistry() {
  if (!declarativeLoaded) {
    for (const builtin of [newApi, oneApi, genericJson]) registerAdapter(builtin);
    loadDeclarativeAdapters();
  }
  return {
    get: id => registry.get(id) || null,
    ids: () => [...registry.keys()],
    list: () => [...registry.values()].map(({ run, match, ...meta }) => meta)
  };
}

export function resolveAdapterForAccount(account) {
  const reg = getRegistry();
  if (account.adapterId) {
    const explicit = reg.get(account.adapterId);
    if (explicit) return explicit;
  }
  // 旧账号兼容映射：panelType newapi/auto -> new-api，generic -> generic-json。
  // 已有账号数据不要求迁移，运行时自动落到对应适配器。
  return reg.get(account.panelType === 'generic' ? 'generic-json' : 'new-api');
}

// 并发有限地执行各适配器 match()，按分数选出唯一最高分。
export async function matchAdapters(context, { minScore = 50, adapters } = {}) {
  const reg = getRegistry();
  const candidates = adapters || reg.list().map(({ id }) => reg.get(id));
  const results = [];
  const queue = [...candidates];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const adapter = queue.shift();
      let outcome;
      try {
        outcome = await adapter.match(context);
      } catch (error) {
        outcome = { score: 0, reason: `match() crashed: ${error.message}` };
      }
      results.push({ adapterId: adapter.id, score: Number(outcome?.score) || 0, reason: outcome?.reason || '' });
    }
  }));
  results.sort((a, b) => b.score - a.score || a.adapterId.localeCompare(b.adapterId));
  const top = results[0];
  if (!top || top.score < minScore) {
    return { adapterId: 'unknown', confidence: 0, reasons: results.filter(x => x.reason).map(x => `${x.adapterId}: ${x.reason}`) };
  }
  const tied = results.filter(x => x.score === top.score);
  if (tied.length > 1) {
    return { adapterId: 'ambiguous', confidence: top.score / 100, candidates: tied, reasons: tied.map(x => `${x.adapterId}: ${x.reason}`) };
  }
  return {
    adapterId: top.adapterId,
    adapter: reg.get(top.adapterId),
    confidence: top.score / 100,
    reasons: results.filter(x => x.score > 0).map(x => `${x.adapterId}: ${x.reason}`)
  };
}

export function resetRegistryForTests() {
  registry.clear();
  declarativeLoaded = false;
}
