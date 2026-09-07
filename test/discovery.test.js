import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSite } from '../adapters/discovery.js';

function stubContext(responses, log = []) {
  return {
    baseUrl: 'https://example.com',
    dryRun: true,
    async fetchJson(path, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      log.push(method);
      return responses[path] || { status: 404, data: null };
    }
  };
}

test('discovery only issues read-only GET requests and classifies candidates', async () => {
  const log = [];
  const context = stubContext({
    '/api/me': { status: 200, data: { data: { id: 1, username: 'u' } } },
    '/api/points': { status: 200, data: { data: { points: 1280 } } },
    '/api/checkin/status': { status: 200, data: { data: { checked: true } } },
    '/api/user/self': { status: 403, data: null }
  }, log);
  const result = await discoverSite(context);
  assert.ok(log.length > 0);
  assert.ok(log.every(method => method === 'GET'), `discovery must stay read-only, saw ${[...new Set(log)]}`);
  assert.deepEqual(result.possibleUserEndpoints.map(x => x.path), ['/api/me']);
  assert.deepEqual(result.possibleBalanceEndpoints.map(x => x.path), ['/api/points']);
  assert.deepEqual(result.possibleCheckinEndpoints.map(x => x.path), ['/api/checkin/status']);
  assert.equal(result.confidence, 1);
  assert.ok(result.notes.some(note => /只读/.test(note)));
  assert.deepEqual(result.methodsUsed, ['GET']);
});

test('discovery reports unknown endpoints as inconclusive candidates', async () => {
  const result = await discoverSite(stubContext({
    '/api/checkin/status': { status: 200, data: { message: 'ok but vague' } }
  }));
  assert.equal(result.possibleCheckinEndpoints.length, 1);
  assert.ok(result.possibleCheckinEndpoints[0].note);
  assert.equal(result.confidence, 0.34);
});

test('discovery survives a context that refuses every request', async () => {
  const result = await discoverSite({
    baseUrl: 'https://example.com',
    async fetchJson() { throw new Error('network down'); }
  });
  assert.deepEqual(result.possibleUserEndpoints, []);
  assert.deepEqual(result.possibleBalanceEndpoints, []);
  assert.deepEqual(result.possibleCheckinEndpoints, []);
  assert.equal(result.confidence, 0);
});
