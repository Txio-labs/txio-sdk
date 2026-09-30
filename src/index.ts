/**
 * TypeScript client for txio's public API
 * (https://api.txio.xyz/api/public/v1 by default). Pre-1.0: shapes can change
 * between releases. The types below mirror `openapi.json`, which the backend
 * publishes at `<baseUrl>/openapi.json` and checks in CI.
 *
 * Get an API key from the Developers page in the txio app.
 */

/** JSON-RPC style codes the API returns. -32000..-32002 are shared with the rest of txio. */
export const ErrorCode = {
    UpstreamUnreachable: -32000,
    NameResolutionFailed: -32001,
    Internal: -32002,
    Unauthorized: -32010,
    Forbidden: -32011,
    RateLimited: -32012,
    InvalidRequest: -32013,
    NotFound: -32014,
    NotImplemented: -32015,
    Conflict: -32016
} as const;

export interface TxioErrorDetails {
    /** JSON-RPC code from the response, when the server sent one. */
    code?: number;
    /** Quote this when asking for support. */
    requestId?: string;
    /** Seconds to wait, from `Retry-After` on a 429. */
    retryAfterSeconds?: number;
}

export class TxioApiError extends Error {
    status: number;
    code?: number;
    requestId?: string;
    retryAfterSeconds?: number;
    constructor(message: string, status: number, details: TxioErrorDetails = {}) {
        super(message);
        this.name = 'TxioApiError';
        this.status = status;
        this.code = details.code;
        this.requestId = details.requestId;
        this.retryAfterSeconds = details.retryAfterSeconds;
        Object.setPrototypeOf(this, TxioApiError.prototype);
    }
}

export interface TxioClientOptions {
    apiKey: string;
    /** Override for self-hosted or non-production deployments. */
    baseUrl?: string;
    /** Retries for network errors, 429 and 502/503/504 on calls that are safe to repeat. Default 2. */
    maxRetries?: number;
    /** Custom fetch, for tests or runtimes without a global one. */
    fetch?: typeof fetch;
    /** Custom delay, for tests. */
    sleep?: (ms: number) => Promise<void>;
}

export type Chain = 'sui' | 'evm' | 'solana' | 'aptos' | 'stellar';

export interface HistoryEntry {
    id: string;
    name: string;
    request_type: 'RPC' | 'TRANSACTION';
    chain?: string | null;
    network: string;
    method?: string | null;
    wallet_family?: string | null;
    wallet_address?: string | null;
    tx_params?: unknown;
    result?: unknown;
    status: number;
    duration_ms: number;
    executed_at: string;
}

export interface HistoryQuery {
    walletAddress?: string;
    walletFamily?: Chain;
    chain?: string;
}

export interface SimulateTransactionParams {
    chain: Chain;
    /** Chain-native parameters, the same shape the txio app builds for that chain. */
    txParams: unknown;
}

export interface EvmExecuteTxParams {
    chain_id: number;
    to: string;
    value?: string;
    data?: string;
}

export interface ExecuteTransactionParams {
    sessionKeyId: string;
    /** Only `evm` is supported today. */
    chain: 'evm';
    txParams: EvmExecuteTxParams;
    /** Makes a retried call safe: the same key and body returns the first result instead of broadcasting again. */
    idempotencyKey?: string;
}

export interface ExecuteTransactionResult {
    hash: string;
}

export type WebhookEventName =
    | 'tx.confirmed'
    | 'tx.failed'
    | 'swap.resumable'
    | 'session_key.expiring'
    | 'spend_limit.reached';

export interface WebhookEvent {
    /** Same as the `X-Txio-Delivery` header; stable across retries. */
    id: string;
    event: WebhookEventName;
    created_at: string;
    data: Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'https://api.txio.xyz/api/public/v1';
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 30;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TxioClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly maxRetries: number;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(options: TxioClientOptions) {
        if (!options.apiKey?.trim()) {
            throw new Error('TxioClient requires an apiKey. Create one from the Developers page in the Txio app.');
        }
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.maxRetries = Math.max(0, options.maxRetries ?? 2);
        this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
        this.sleep = options.sleep ?? defaultSleep;
    }

    /**
     * `retry` says whether repeating the call is safe. GETs, `simulate` (no side
     * effects) and `execute` with an idempotency key are; a bare `execute` is not,
     * because a timeout may have happened after the transaction was broadcast.
     */
    private async request<T>(path: string, init: RequestInit = {}, retry = false, noAuth = false): Promise<T> {
        const attempts = retry ? this.maxRetries + 1 : 1;
        let lastError: TxioApiError | null = null;

        for (let attempt = 0; attempt < attempts; attempt++) {
            let response: Response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                    ...init,
                    headers: {
                        ...(noAuth ? {} : { Authorization: `Bearer ${this.apiKey}` }),
                        'Content-Type': 'application/json',
                        ...(init.headers ?? {})
                    }
                });
            } catch (error) {
                lastError = new TxioApiError(
                    error instanceof Error && error.message.trim() ? error.message : 'Unable to reach the Txio API.',
                    0,
                    { code: ErrorCode.UpstreamUnreachable }
                );
                if (attempt + 1 < attempts) {
                    await this.sleep(backoffMs(attempt));
                    continue;
                }
                throw lastError;
            }

            const contentType = response.headers.get('content-type') ?? '';
            const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : null;

            if (response.ok) return body as T;

            const retryAfter = Number(response.headers.get('retry-after'));
            lastError = toApiError(response.status, body, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);

            if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < attempts) {
                const waitMs =
                    lastError.retryAfterSeconds !== undefined
                        ? Math.min(lastError.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000
                        : backoffMs(attempt);
                await this.sleep(waitMs);
                continue;
            }
            throw lastError;
        }

        throw lastError ?? new TxioApiError('Request failed.', 0);
    }

    /** Requires the `history:read` scope. */
    async getHistory(query: HistoryQuery = {}): Promise<HistoryEntry[]> {
        const params = new URLSearchParams();
        if (query.walletAddress) params.set('wallet_address', query.walletAddress);
        if (query.walletFamily) params.set('wallet_family', query.walletFamily);
        if (query.chain) params.set('chain', query.chain);
        const qs = params.toString();
        return this.request<HistoryEntry[]>(`/history${qs ? `?${qs}` : ''}`, {}, true);
    }

    /**
     * Requires the `transactions:simulate` scope. The server has no simulation
     * yet, so this rejects with a `TxioApiError` whose `code` is
     * `ErrorCode.NotImplemented` (-32015) instead of returning a result that
     * looks like a passed check. Simulate with the txio app or CLI, then call
     * `executeTransaction`.
     */
    async simulateTransaction(params: SimulateTransactionParams): Promise<never> {
        return this.request<never>(
            '/transactions/simulate',
            { method: 'POST', body: JSON.stringify({ chain: params.chain, tx_params: params.txParams }) },
            true
        );
    }

    /**
     * Requires the `transactions:execute` scope and a session key (create one
     * from the Automation page first; a public API caller has no human present
     * to approve a signature). EVM only today. Pass `idempotencyKey` to make
     * retries safe; without it a failed call is never retried automatically.
     */
    async executeTransaction(params: ExecuteTransactionParams): Promise<ExecuteTransactionResult> {
        return this.request<ExecuteTransactionResult>(
            '/transactions/execute',
            {
                method: 'POST',
                headers: params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {},
                body: JSON.stringify({
                    session_key_id: params.sessionKeyId,
                    chain: params.chain,
                    tx_params: params.txParams
                })
            },
            Boolean(params.idempotencyKey)
        );
    }

    /** The API's OpenAPI document. Needs no scope. */
    async getOpenApiDocument(): Promise<Record<string, unknown>> {
        return this.request<Record<string, unknown>>('/openapi.json', {}, true, true);
    }
}

const backoffMs = (attempt: number) => 250 * 2 ** attempt + Math.floor(Math.random() * 100);

const toApiError = (status: number, body: unknown, retryAfterSeconds?: number): TxioApiError => {
    const error = (body as { error?: { code?: unknown; message?: unknown; data?: { requestId?: unknown } } } | null)?.error;
    const message =
        typeof error?.message === 'string' && error.message
            ? error.message
            : `Txio API request failed with status ${status}.`;
    return new TxioApiError(message, status, {
        code: typeof error?.code === 'number' ? error.code : undefined,
        requestId: typeof error?.data?.requestId === 'string' ? error.data.requestId : undefined,
        retryAfterSeconds
    });
};

export interface VerifyWebhookParams {
    /** The signing secret shown when the webhook was created or rotated. */
    secret: string;
    /** `X-Txio-Timestamp` header. */
    timestamp: string;
    /** The raw request body exactly as received, before any JSON parsing. */
    body: string;
    /** `X-Txio-Signature` header (`v1=<hex>`). */
    signature: string;
    /** Reject signatures older than this many seconds. Default 300. */
    toleranceSeconds?: number;
    /** Current unix time in seconds; for tests. */
    now?: number;
}

/**
 * Checks a webhook delivery: HMAC-SHA256 of `<timestamp>.<body>` with your
 * secret, compared in constant time, and a timestamp inside the tolerance
 * window. Uses Web Crypto, so it runs in Node 18+, Deno, Bun, edge runtimes and browsers.
 */
export async function verifyWebhookSignature(params: VerifyWebhookParams): Promise<boolean> {
    const ts = Number(params.timestamp);
    if (!Number.isFinite(ts)) return false;
    const now = params.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > (params.toleranceSeconds ?? 300)) return false;
    if (!params.signature.startsWith('v1=')) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(params.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${params.timestamp}.${params.body}`)));
    const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
    const given = params.signature.slice(3);

    if (given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    return diff === 0;
}
