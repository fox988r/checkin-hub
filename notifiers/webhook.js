// Generic webhook 通知器：设置 NOTIFY_WEBHOOK_URL 后启用。
// POST { type, accountName, accountId, detail, at } —— 不携带任何凭据。
import { registerNotifier } from './registry.js';

const webhookUrl = process.env.NOTIFY_WEBHOOK_URL || '';

export const NOTIFIER_ACTIVE = Boolean(webhookUrl);

if (webhookUrl) {
  registerNotifier('webhook', async event => {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);
  });
}
