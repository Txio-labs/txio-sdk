import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { ErrorCode, TxioApiError, TxioClient, verifyWebhookSignature } from '../dist/index.js';

const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const envelope = (code, message, status, requestId = 'req-1') => ({
    jsonrpc: '2.0', error: { code, message, data: { status, requestId } }, id: null
});
const client = (fetchImpl, extra = {}) =>
    new TxioClient({ apiKey: 'txio_live_x', baseUrl: 'https://api.test/v1/', fetch: fetchImpl, sleep: async () => {}, ...extra });

test('parses the JSON-RPC error envelope into a typed error', async () => {
    const c = client(async () => json(envelope(-32011, "This API key does not have the 'history:read' scope", 403), 403));
    const error = await c.getHistory().catch((e) => e);
    assert.ok(error instanceof TxioApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, ErrorCode.Forbidden);
    assert.equal(error.requestId, 'req-1');
});

test('sends the bearer key and builds the history query', async () => {
    let seen;
    const c = client(async (url, init) => { seen = { url, init }; return json([]); });
    await c.getHistory({ walletAddress: '0xabc', chain: 'evm' });
    assert.equal(seen.url, 'https://api.test/v1/history?wallet_address=0xabc&chain=evm');
    assert.equal(seen.init.headers.Authorization, 'Bearer txio_live_x');
});

test('retries 429 honouring Retry-After, then succeeds', async () => {
    const waits = [];
    let calls = 0;
    const c = client(async () => (++calls < 3 ? json(envelope(-32012, 'slow down', 429), 429, { 'retry-after': '2' }) : json([])), {
        sleep: async (ms) => { waits.push(ms); }
    });
    assert.deepEqual(await c.getHistory(), []);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 2000]);
});

test('gives up after maxRetries and reports Retry-After', async () => {
    const c = client(async () => json(envelope(-32012, 'slow down', 429), 429, { 'retry-after': '5' }), { maxRetries: 1 });
    const error = await c.getHistory().catch((e) => e);
    assert.equal(error.code, ErrorCode.RateLimited);
    assert.equal(error.retryAfterSeconds, 5);
});

test('never retries a non-idempotent execute, even on a network error', async () => {
    let calls = 0;
    const c = client(async () => { calls++; throw new TypeError('socket hang up'); });
    const error = await c.executeTransaction({ sessionKeyId: 's', chain: 'evm', txParams: { chain_id: 1, to: '0x1' } }).catch((e) => e);
    assert.equal(calls, 1);
    assert.equal(error.status, 0);
    assert.equal(error.code, ErrorCode.UpstreamUnreachable);
});

test('retries execute only with an idempotency key, and sends it', async () => {
    let calls = 0;
    const keys = [];
    const c = client(async (_url, init) => {
        keys.push(init.headers['Idempotency-Key']);
        return ++calls === 1 ? json(envelope(-32000, 'bad gateway', 502), 502) : json({ hash: '0xhash' });
    });
    const result = await c.executeTransaction({ sessionKeyId: 's', chain: 'evm', txParams: { chain_id: 1, to: '0x1' }, idempotencyKey: 'k-1' });
    assert.deepEqual(result, { hash: '0xhash' });
    assert.deepEqual(keys, ['k-1', 'k-1']);
});

test('simulate rejects with NotImplemented instead of a fake result', async () => {
    const c = client(async () => json(envelope(-32015, 'Server-side simulation is not available for evm.', 501), 501));
    const error = await c.simulateTransaction({ chain: 'evm', txParams: {} }).catch((e) => e);
    assert.equal(error.status, 501);
    assert.equal(error.code, ErrorCode.NotImplemented);
});

test('requires an api key', () => {
    assert.throws(() => new TxioClient({ apiKey: '  ' }), /apiKey/);
});

test('verifies webhook signatures: valid, tampered, stale and malformed', async () => {
    const secret = 'whsec_test';
    const body = '{"id":"d1","event":"tx.confirmed","created_at":"2026-01-01T00:00:00Z","data":{}}';
    const timestamp = '1700000000';
    const signature = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const base = { secret, timestamp, body, signature, now: 1700000100 };

    assert.equal(await verifyWebhookSignature(base), true);
    assert.equal(await verifyWebhookSignature({ ...base, body: body + ' ' }), false);
    assert.equal(await verifyWebhookSignature({ ...base, secret: 'whsec_other' }), false);
    assert.equal(await verifyWebhookSignature({ ...base, now: 1700000000 + 301 }), false);
    assert.equal(await verifyWebhookSignature({ ...base, signature: signature.slice(3) }), false);
    assert.equal(await verifyWebhookSignature({ ...base, timestamp: 'abc' }), false);
});

test('every documented operation has a client method', () => {
    const doc = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
    const methodFor = { getOpenApiDocument: 'getOpenApiDocument', getHistory: 'getHistory', simulateTransaction: 'simulateTransaction', executeTransaction: 'executeTransaction' };
    const c = new TxioClient({ apiKey: 'k' });
    for (const id of operations) {
        assert.ok(methodFor[id], `no SDK mapping for operation ${id}`);
        assert.equal(typeof c[methodFor[id]], 'function', `TxioClient.${methodFor[id]} is missing`);
    }
});
