/**
 * TypeScript client for Txio's public execution API
 * (https://api.txio.xyz/api/public/v1 by default). Wraps the same
 * simulate/execute/history endpoints the Txio app itself calls internally
 * (at /api/v1, with JWT auth) — this SDK targets the distinct
 * /api/public/v1 prefix with API-key auth instead, following the same
 * raw-fetch + typed-error convention as the main app's services/api.ts.
 *
 * Get an API key from the Developers page in the Txio app.
 */

export class TxioApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'TxioApiError';
        this.status = status;
        Object.setPrototypeOf(this, TxioApiError.prototype);
    }
}

export interface TxioClientOptions {
    apiKey: string;
    /** Override for self-hosted or non-production deployments. */
    baseUrl?: string;
}

export interface HistoryEntry {
    id?: string;
    name: string;
    request_type: string;
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
    walletFamily?: string;
    chain?: string;
}

export interface SimulateTransactionParams {
    chain: string;
    txParams: unknown;
}

export interface SimulateTransactionResult {
    chain: string;
    simulated: boolean;
    note: string;
}

export interface ExecuteTransactionParams {
    sessionKeyId: string;
    chain: string;
    txParams: unknown;
}

export interface ExecuteTransactionResult {
    hash: string;
}

const DEFAULT_BASE_URL = 'https://api.txio.xyz/api/public/v1';

export class TxioClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(options: TxioClientOptions) {
        if (!options.apiKey?.trim()) {
            throw new Error('TxioClient requires an apiKey. Create one from the Developers page in the Txio app.');
        }
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    }

    private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                ...init,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    ...(init.headers ?? {})
                }
            });
        } catch (error) {
            throw new TxioApiError(
                error instanceof Error && error.message.trim() ? error.message : 'Unable to reach the Txio API.',
                0
            );
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = contentType.includes('application/json') ? await response.json().catch(() => null) : null;

        if (!response.ok) {
            const message =
                (body && typeof body === 'object' && 'message' in body && typeof (body as { message?: unknown }).message === 'string'
                    ? (body as { message: string }).message
                    : null) ?? `Txio API request failed with status ${response.status}.`;
            throw new TxioApiError(message, response.status);
        }

        return body as T;
    }

    /** Requires the `history:read` scope. */
    async getHistory(query: HistoryQuery = {}): Promise<HistoryEntry[]> {
        const params = new URLSearchParams();
        if (query.walletAddress) params.set('wallet_address', query.walletAddress);
        if (query.walletFamily) params.set('wallet_family', query.walletFamily);
        if (query.chain) params.set('chain', query.chain);
        const qs = params.toString();
        return this.request<HistoryEntry[]>(`/history${qs ? `?${qs}` : ''}`);
    }

    /**
     * Requires the `transactions:simulate` scope. Currently a stub on the
     * server side — Txio has no server-side chain-RPC simulation layer yet
     * (simulation lives in the frontend app today), so this returns
     * `simulated: false` with an explanatory note rather than a fabricated
     * result. Simulate client-side against the target chain's own RPC
     * before calling `executeTransaction` if you need a real dry-run.
     */
    async simulateTransaction(params: SimulateTransactionParams): Promise<SimulateTransactionResult> {
        return this.request<SimulateTransactionResult>('/transactions/simulate', {
            method: 'POST',
            body: JSON.stringify({ chain: params.chain, tx_params: params.txParams })
        });
    }

    /**
     * Requires the `transactions:execute` scope and a session key (create
     * one from the Automation page in the Txio app first — a public API
     * caller has no human present to approve a signature, so execution
     * only works through a pre-authorized session key, same as a scheduled
     * task). EVM only today.
     */
    async executeTransaction(params: ExecuteTransactionParams): Promise<ExecuteTransactionResult> {
        return this.request<ExecuteTransactionResult>('/transactions/execute', {
            method: 'POST',
            body: JSON.stringify({
                session_key_id: params.sessionKeyId,
                chain: params.chain,
                tx_params: params.txParams
            })
        });
    }
}
