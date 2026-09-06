import test from 'node:test';
import assert from 'node:assert/strict';
import { listNotifiers, notify, notifySafe, registerNotifier, unregisterNotifier } from '../notifiers/registry.js';

test('notifiers fan out events and isolate sender failures', async () => {
  const seen = [];
  registerNotifier('a', async event => { seen.push(`a:${event.type}`); });
  registerNotifier('b', async () => { throw new Error('webhook down'); });
  const results = await notify({ type: 'checkin_failed_streak', accountName: '糖糕站' });
  assert.deepEqual(seen, ['a:checkin_failed_streak']);
  assert.equal(results.find(x => x.id === 'a').ok, true);
  assert.equal(results.find(x => x.id === 'b').ok, false);
  assert.ok(listNotifiers().includes('a') && listNotifiers().includes('b'));
  unregisterNotifier('a');
  unregisterNotifier('b');
  assert.equal(listNotifiers().includes('a'), false);
});

test('notifySafe never rejects even when all senders fail', async () => {
  registerNotifier('always-fails', async () => { throw new Error('nope'); });
  await assert.doesNotReject(() => notifySafe({ type: 'auth_expired' }));
  unregisterNotifier('always-fails');
});

test('notify with no senders is a silent no-op', async () => {
  const results = await notify({ type: 'balance_changed' });
  assert.deepEqual(results, []);
});
