/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IByokLmChatRequest, IByokLmChatResult, visibleByokLmModels } from '../../common/agentHostByokLm.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { parseProxyBearer, ProxyBearerAuth } from '../claude/claudeProxyAuth.js';
import {
	ILoopbackProxyHandle,
	ILoopbackProxyRuntime,
	IProxyInFlight,
	LoopbackProxyServer,
	readProxyRequestBody,
} from '../shared/loopbackProxyServer.js';
import {
	bridgeResultToResponsesBody,
	bridgeResultToResponsesSseFrames,
	IResponsesRequest,
	responsesErrorBody,
	responsesRequestToBridge,
} from './byokResponsesTranslation.js';
import { ByokWireErrorType, ByokWireTranslationError, modelsListBody } from './byokWireCommon.js';

// #region Public types

/**
 * The three request wires the proxy serves, one per agent runtime family:
 * OpenAI Responses (Copilot / Codex runtimes), Anthropic Messages (the Claude
 * Code CLI) and OpenAI Chat Completions (the Kimi and DeepSeek SDKs).
 */
export type ByokLmWireProtocol = 'responses';

/**
 * Handle returned by {@link IByokLmProxyService.start}. Refcounts the shared
 * loopback server (see {@link LoopbackProxyServer}): when every handle is
 * disposed the listener closes and the nonce is destroyed; the next `start()`
 * rebinds with a fresh port and nonce.
 *
 * **Subprocess ownership invariant.** Callers that hand `baseUrl`/`nonce` to
 * the Copilot SDK runtime subprocess MUST kill that subprocess before calling
 * `dispose()` — after disposal the proxy may rebind on a different port and the
 * subprocess would silently lose its endpoint (same contract as the Claude and
 * Codex proxies).
 */
export interface IByokLmProxyHandle extends ILoopbackProxyHandle {
	/** e.g. `http://127.0.0.1:54321` — no trailing slash. */
	readonly baseUrl: string;
	/** 256-bit hex string. Combine with a session id as `Bearer <nonce>.<sessionId>`. */
	readonly nonce: string;
	/**
	 * Build the vendor-scoped base URL; the Copilot runtime appends
	 * `/responses`.
	 */
	providerBaseUrl(vendor: string, wire?: ByokLmWireProtocol): string;
}

export const IByokLmProxyService = createDecorator<IByokLmProxyService>('byokLmProxyService');

export interface IByokLmProxyService {
	readonly _serviceBrand: undefined;

	/** Start the proxy (if not already running) and return a refcounted handle. */
	start(): Promise<IByokLmProxyHandle>;

	/**
	 * Force-close the proxy regardless of refcount and abort in-flight
	 * requests. Idempotent; subsequent `start()` calls rebind.
	 */
	dispose(): void;
}

// #endregion

const PROXY_USER_FACING_NAME = 'ByokLmProxyService';
const VENDOR_PATH_PREFIX = '/v/';

/** Endpoints served under `/v/<vendor>/`, on top of the three request wires. */
type ByokLmEndpoint = ByokLmWireProtocol | 'models';

/**
 * Path suffixes accepted after `/v/<vendor>`, with a leading `/v1` stripped
 * first.
 */
const ENDPOINT_BY_SUFFIX = new Map<string, ByokLmEndpoint>([
	['/responses', 'responses'],
	['/models', 'models'],
]);

/** A parsed inbound route: which vendor, which endpoint. */
interface IByokLmRoute {
	readonly vendor: string;
	readonly endpoint: ByokLmEndpoint;
}

/**
 * Responses request/response projection around the renderer bridge.
 */
interface IByokLmWire {
	readonly parse: (vendor: string, raw: string) => { readonly request: IByokLmChatRequest; readonly stream: boolean };
	readonly body: (result: IByokLmChatResult, modelId: string) => string;
	readonly frames: (result: IByokLmChatResult, modelId: string) => string[];
	readonly error: (message: string, type: ByokWireErrorType) => string;
}

function parseJsonBody<T>(raw: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		throw new ByokWireTranslationError(`Invalid request body: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const WIRES: Record<ByokLmWireProtocol, IByokLmWire> = {
	'responses': {
		parse: (vendor, raw) => {
			const body = parseJsonBody<IResponsesRequest>(raw);
			return { request: responsesRequestToBridge(vendor, body), stream: body.stream === true };
		},
		body: bridgeResultToResponsesBody,
		frames: bridgeResultToResponsesSseFrames,
		error: responsesErrorBody,
	},
};

/**
 * The envelope an endpoint's errors are rendered in. `models` is probed by both
 * client families and answers with a body that satisfies both, so its errors
 * use the OpenAI envelope; `count-tokens` is Anthropic-only.
 */
function errorWire(endpoint: ByokLmEndpoint): IByokLmWire {
	return WIRES.responses;
}

/**
 * Extract the vendor and endpoint from a `/v/<vendor>[/v1]/<suffix>` path.
 */
export function parseByokLmProxyPath(pathname: string): IByokLmRoute | undefined {
	if (!pathname.startsWith(VENDOR_PATH_PREFIX)) {
		return undefined;
	}
	const rest = pathname.slice(VENDOR_PATH_PREFIX.length);
	const separator = rest.indexOf('/');
	if (separator <= 0) {
		return undefined;
	}
	let vendor: string;
	try {
		vendor = decodeURIComponent(rest.slice(0, separator));
	} catch {
		return undefined;
	}
	// Re-check for a path separator *after* decoding: a `%2F` survives the
	// pre-decode segment split but would decode into a second path segment,
	// breaking the single-segment `vendor/id` selection-id convention.
	if (!vendor || vendor.includes('/')) {
		return undefined;
	}
	let suffix = rest.slice(separator);
	if (suffix.startsWith('/v1/')) {
		suffix = suffix.slice('/v1'.length);
	}
	const endpoint = ENDPOINT_BY_SUFFIX.get(suffix);
	return endpoint ? { vendor, endpoint } : undefined;
}

/**
 * Authenticate an inbound request. Every client is handed
 * `<nonce>.<sessionId>`; Anthropic clients configured with an API key put it in
 * `x-api-key` instead of `Authorization`, so both headers are accepted — the
 * token still has to match this bind's nonce, so a stray `ANTHROPIC_API_KEY`
 * from the user's environment cannot authenticate.
 */
function parseByokLmProxyAuth(headers: http.IncomingHttpHeaders, expectedNonce: string): ProxyBearerAuth {
	const bearer = parseProxyBearer(headers, expectedNonce);
	if (bearer.valid) {
		return bearer;
	}
	const apiKey = headers['x-api-key'];
	return typeof apiKey === 'string'
		? parseProxyBearer({ authorization: `Bearer ${apiKey}` }, expectedNonce)
		: bearer;
}

/**
 * The BYOK proxy keeps no per-bind mutable state: the active renderer bridge is
 * resolved from {@link IByokLmBridgeRegistry} at request time, and the nonce
 * lives on the runtime owned by {@link LoopbackProxyServer}.
 */
type ByokLmProxyState = undefined;

/**
 * Upstream local HTTP proxy for Copilot CLI BYOK Responses requests. Native
 * Fumie harnesses use `NativeModelProviderProxyService` instead.
 *
 * | route                                     | wire                   | client                     |
 * |-------------------------------------------|------------------------|----------------------------|
 * | `POST /v/<vendor>[/v1]/responses`         | OpenAI Responses       | Copilot CLI                |
 * | `GET  /v/<vendor>[/v1]/models`            | model list             | catalogue probes           |
 *
 * The bridge answers with a buffered completion, so a `stream: true` request is
 * served by replaying that completion as the wire's SSE event sequence once it
 * arrives.
 *
 * The server lifecycle — lazy bind on `127.0.0.1`, nonce minting, refcounted
 * handles, in-flight tracking, and teardown — is inherited from
 * {@link LoopbackProxyServer}; this subclass only implements request routing.
 */
export class ByokLmProxyService extends LoopbackProxyServer<ByokLmProxyState> implements IByokLmProxyService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService logService: ILogService,
		@IByokLmBridgeRegistry private readonly _bridgeRegistry: IByokLmBridgeRegistry,
	) {
		super(PROXY_USER_FACING_NAME, logService);
	}

	protected createState(): ByokLmProxyState {
		// No per-bind state — the bridge is resolved from the registry per request.
		return undefined;
	}

	async start(): Promise<IByokLmProxyHandle> {
		const { runtime, release } = await this.acquire();

		let disposed = false;
		return {
			baseUrl: runtime.baseUrl,
			nonce: runtime.nonce,
			providerBaseUrl: (vendor: string, _wire: ByokLmWireProtocol = 'responses') => {
				const base = `${runtime.baseUrl}${VENDOR_PATH_PREFIX}${encodeURIComponent(vendor)}`;
				return base;
			},
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				release();
			},
		};
	}

	/** Emit the base's fallback failure using the OpenAI error envelope. */
	protected override writeInternalError(res: http.ServerResponse): void {
		this._writeError(res, WIRES.responses, 500, 'Internal proxy error', 'api_error');
	}

	protected override async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, runtime: ILoopbackProxyRuntime<ByokLmProxyState>): Promise<void> {
		const method = req.method ?? 'GET';
		const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		this._logService.trace(`[${PROXY_USER_FACING_NAME}] ${method} ${pathname}`);

		if (method === 'GET' && pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('ok');
			return;
		}

		const route = parseByokLmProxyPath(pathname);
		const expectedMethod = route?.endpoint === 'models' ? 'GET' : 'POST';
		if (!route || method !== expectedMethod) {
			this._writeError(res, WIRES.responses, 404, `No route for ${method} ${pathname}`, 'not_found_error');
			return;
		}
		const wire = errorWire(route.endpoint);

		// Inbound requests carry `<nonce>.<sessionId>`; the runtime is handed
		// that token at session launch.
		const auth = parseByokLmProxyAuth(req.headers, runtime.nonce);
		if (!auth.valid || !auth.sessionId) {
			this._writeError(res, wire, 401, 'Invalid authentication', 'authentication_error');
			return;
		}

		switch (route.endpoint) {
			case 'models':
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(modelsListBody(visibleByokLmModels(this._bridgeRegistry.getModels()), route.vendor));
				return;
			default:
				await this._handleChat(req, res, runtime, route.vendor, WIRES[route.endpoint]);
		}
	}

	private async _handleChat(req: http.IncomingMessage, res: http.ServerResponse, runtime: ILoopbackProxyRuntime<ByokLmProxyState>, vendor: string, wire: IByokLmWire): Promise<void> {
		let bridgeRequest: IByokLmChatRequest;
		let stream: boolean;
		try {
			({ request: bridgeRequest, stream } = wire.parse(vendor, await readProxyRequestBody(req)));
		} catch (err) {
			this._writeError(res, wire, 400, err instanceof Error ? err.message : String(err), 'invalid_request_error');
			return;
		}

		const connection = this._bridgeRegistry.getServingConnection();
		if (!connection) {
			this._writeError(res, wire, 503, 'No renderer connection available to service BYOK models', 'api_error');
			return;
		}

		// Register the request so {@link LoopbackProxyServer} aborts it on
		// teardown; a client-side disconnect also flips `clientGone` and aborts.
		// Both surface through the shared `AbortController`, which we re-check
		// after the async bridge hop before touching the response.
		const entry: IProxyInFlight = { ac: new AbortController(), res, clientGone: false };
		runtime.inFlight.add(entry);
		const onClose = () => {
			entry.clientGone = true;
			entry.ac.abort();
		};
		res.on('close', onClose);

		try {
			const result = await connection.chat(bridgeRequest);
			if (entry.ac.signal.aborted || res.writableEnded) {
				return;
			}
			if (result.error) {
				this._writeError(res, wire, 502, result.error, 'api_error');
				return;
			}
			if (stream) {
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				});
				for (const frame of wire.frames(result, bridgeRequest.modelId)) {
					res.write(frame);
				}
				res.end();
			} else {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(wire.body(result, bridgeRequest.modelId));
			}
		} catch (err) {
			if (entry.ac.signal.aborted || res.writableEnded) {
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				this._writeError(res, wire, 502, message, 'api_error');
			} else {
				try { res.end(); } catch { /* ignore */ }
			}
		} finally {
			res.removeListener('close', onClose);
			runtime.inFlight.delete(entry);
		}
	}

	private _writeError(res: http.ServerResponse, wire: IByokLmWire, status: number, message: string, type: ByokWireErrorType): void {
		if (res.headersSent || res.writableEnded) {
			return;
		}
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(wire.error(message, type));
	}
}

/**
 * No-op {@link IByokLmProxyService} for agent host entrypoints that do not
 * support BYOK — e.g. the remote agent host, where no extension host runs
 * alongside the agent host to serve the renderer LM API.
 *
 */
export class NullByokLmProxyService implements IByokLmProxyService {

	declare readonly _serviceBrand: undefined;

	start(): Promise<IByokLmProxyHandle> {
		return Promise.reject(new Error('BYOK is not supported in this agent host'));
	}

	dispose(): void {
		// No-op: the null proxy never binds a socket, so there is nothing to close.
	}
}
