/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IByokLmModelInfo, IByokLmProviderConfiguration, visibleByokLmModels } from '../common/agentHostByokLm.js';
import { IAgentHostProxyResolver } from './agentHostProxyResolver.js';
import { IByokLmBridgeRegistry } from './byokLmBridgeRegistry.js';
import { CHATGPT_SUBSCRIPTION_RESPONSES_URL, CHATGPT_SUBSCRIPTION_SERVICE_TIER_PARAMETER, CHATGPT_SUBSCRIPTION_SOURCE, CHATGPT_SUBSCRIPTION_UNSUPPORTED_PARAMETERS, IChatGptSubscriptionService, chatGptSubscriptionUpstreamHeaders, parseChatGptSubscriptionModelId } from './chatGptSubscription.js';
import { parseProxyBearer } from './claude/claudeProxyAuth.js';
import { ILoopbackProxyHandle, ILoopbackProxyRuntime, IProxyInFlight, LoopbackProxyServer, readProxyRequestBody } from './shared/loopbackProxyServer.js';

export type NativeModelWireProtocol = 'responses' | 'messages' | 'chat-completions';

export interface INativeModelProviderProxyHandle extends ILoopbackProxyHandle {
	/** Base URL for a runtime that appends its own protocol endpoint. */
	providerBaseUrl(wire: NativeModelWireProtocol): string;
}

export const INativeModelProviderProxyService = createDecorator<INativeModelProviderProxyService>('nativeModelProviderProxyService');

export interface INativeModelProviderProxyService {
	readonly _serviceBrand: undefined;
	start(): Promise<INativeModelProviderProxyHandle>;
	dispose(): void;
}

type NativeModelProviderProxyState = undefined;

interface ICustomEndpointModel {
	readonly id?: unknown;
	readonly url?: unknown;
	readonly apiType?: unknown;
	readonly requestHeaders?: unknown;
}

/**
 * Where one request goes and how it authenticates there.
 *
 * `apiKey` is a value read at resolve time, not a stored one: a user-configured
 * endpoint yields the key from its configuration, while a subscription upstream
 * yields the access token its owner holds right now. Resolution is therefore
 * asynchronous and happens per request — see {@link IResolvedRoute}.
 */
interface IResolvedEndpoint {
	readonly url: string;
	readonly apiKey: string;
	readonly apiType: string | undefined;
	readonly providerKind: string | undefined;
	readonly requestHeaders: Readonly<Record<string, string>>;
}

/** A resolved endpoint plus the model id the upstream expects in the body. */
interface IResolvedRoute {
	readonly modelId: string;
	readonly endpoint: IResolvedEndpoint;
	/**
	 * Body parameters this upstream rejects outright, removed before forwarding.
	 * Empty for a configured endpoint: the user's own URL speaks its own wire,
	 * and the proxy stays transparent to it.
	 */
	readonly unsupportedParameters: readonly string[];
	/**
	 * Body parameters this upstream needs that the client had no way to send,
	 * written after the unsupported ones are removed. Absent for a configured
	 * endpoint: nothing is added to a body the user's own client composed.
	 */
	readonly bodyParameters?: Readonly<Record<string, unknown>>;
}

const PROXY_NAME = 'NativeModelProviderProxyService';
/** Upstream error bodies are small; the cap is only a guard against a pathological one. */
const UPSTREAM_FAILURE_LOG_LIMIT = 2000;
/**
 * How much of a successful response prefix is inspected for the model the
 * upstream says answered. Every shape we forward names it within the first
 * event or the first few hundred bytes; the cap is what keeps the inspection
 * from growing with the response.
 */
const UPSTREAM_MODEL_SNIFF_LIMIT = 8192;
const USER_AUTH_HEADERS = new Set(['api-key', 'authorization', 'x-api-key', 'x-goog-api-key', 'apikey']);
const PASSTHROUGH_PATHS = new Map<string, NativeModelWireProtocol>([
	['/responses', 'responses'],
	['/v1/responses', 'responses'],
	['/messages', 'messages'],
	['/v1/messages', 'messages'],
	['/messages/count_tokens', 'messages'],
	['/v1/messages/count_tokens', 'messages'],
	['/chat/completions', 'chat-completions'],
	['/v1/chat/completions', 'chat-completions'],
]);

/**
 * Wire-transparent proxy for native harnesses. It reads only the request's
 * `model` field to locate the owning provider group, replaces that routing id
 * with the provider-local model id, and streams the provider response back
 * unchanged. It does not translate Messages, Responses, or Chat Completions.
 */
export class NativeModelProviderProxyService extends LoopbackProxyServer<NativeModelProviderProxyState> implements INativeModelProviderProxyService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService logService: ILogService,
		@IByokLmBridgeRegistry private readonly _bridgeRegistry: IByokLmBridgeRegistry,
		@IAgentHostProxyResolver private readonly _proxyResolver: IAgentHostProxyResolver,
		@IChatGptSubscriptionService private readonly _chatGptSubscription: IChatGptSubscriptionService,
	) {
		super(PROXY_NAME, logService);
	}

	protected createState(): NativeModelProviderProxyState {
		return undefined;
	}

	async start(): Promise<INativeModelProviderProxyHandle> {
		const { runtime, release } = await this.acquire();
		let disposed = false;
		return {
			baseUrl: runtime.baseUrl,
			nonce: runtime.nonce,
			providerBaseUrl: wire => wire === 'chat-completions' ? `${runtime.baseUrl}/v1` : runtime.baseUrl,
			dispose: () => {
				if (!disposed) {
					disposed = true;
					release();
				}
			},
		};
	}

	protected override async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, runtime: ILoopbackProxyRuntime<NativeModelProviderProxyState>): Promise<void> {
		const method = req.method ?? 'GET';
		const inboundUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (method === 'GET' && inboundUrl.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('ok');
			return;
		}
		if (method === 'GET' && (inboundUrl.pathname === '/models' || inboundUrl.pathname === '/v1/models')) {
			if (!this._authenticate(req.headers, runtime.nonce)) {
				this._writeError(res, 401, 'Invalid authentication');
				return;
			}
			this._writeModels(res, visibleByokLmModels(this._bridgeRegistry.getModels()));
			return;
		}
		const wire = PASSTHROUGH_PATHS.get(inboundUrl.pathname);
		if (method !== 'POST' || !wire) {
			this._writeError(res, 404, `No route for ${method} ${inboundUrl.pathname}`);
			return;
		}
		if (!this._authenticate(req.headers, runtime.nonce)) {
			this._writeError(res, 401, 'Invalid authentication');
			return;
		}

		let raw: string;
		let body: Record<string, unknown>;
		try {
			raw = await readProxyRequestBody(req);
			body = JSON.parse(raw) as Record<string, unknown>;
		} catch (error) {
			this._writeError(res, 400, `Invalid request body: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const modelIdentifier = typeof body.model === 'string' ? body.model : undefined;
		if (!modelIdentifier) {
			this._writeError(res, 400, 'model is required');
			return;
		}

		let route: IResolvedRoute;
		try {
			const resolved = await this._resolveRoute(modelIdentifier);
			if (!resolved) {
				this._writeError(res, 404, `No configured provider owns model '${modelIdentifier}'`);
				return;
			}
			this._assertWireSupported(resolved.endpoint, wire);
			route = resolved;
		} catch (error) {
			// The same 400 a rejecting upstream produces, so name which one this is.
			const message = error instanceof Error ? error.message : String(error);
			this._logService.warn(`[${this.name}] could not route model '${modelIdentifier}': ${message}`);
			this._writeError(res, 400, message);
			return;
		}

		const endpoint = route.endpoint;
		body.model = route.modelId;
		for (const parameter of route.unsupportedParameters) {
			delete body[parameter];
		}
		for (const [parameter, value] of Object.entries(route.bodyParameters ?? {})) {
			body[parameter] = value;
		}
		const upstreamUrl = this._upstreamUrl(endpoint.url, inboundUrl);
		const headers = this._upstreamHeaders(req.headers, endpoint, wire);
		const entry: IProxyInFlight = { ac: new AbortController(), res, clientGone: false };
		runtime.inFlight.add(entry);
		const onClose = () => {
			entry.clientGone = true;
			entry.ac.abort();
		};
		res.on('close', onClose);
		let sniffer: UpstreamModelSniffer | undefined;

		try {
			const response = await this._proxyResolver.fetch(upstreamUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: entry.ac.signal,
			});
			if (entry.ac.signal.aborted || res.writableEnded) {
				return;
			}
			if (!response.ok) {
				await this._forwardUpstreamFailure(response, res, route.modelId, body);
				return;
			}
			res.writeHead(response.status, this._responseHeaders(response.headers));
			sniffer = new UpstreamModelSniffer();
			if (!response.body) {
				res.end();
				return;
			}
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done || entry.ac.signal.aborted || res.writableEnded) {
					break;
				}
				const chunk = Buffer.from(value);
				// Forward first, inspect after: the client's bytes never wait on us.
				res.write(chunk);
				sniffer.observe(chunk);
			}
			if (!res.writableEnded) {
				res.end();
			}
		} catch (error) {
			if (!entry.ac.signal.aborted && !res.writableEnded) {
				this._writeError(res, 502, error instanceof Error ? error.message : String(error));
			}
		} finally {
			res.removeListener('close', onClose);
			runtime.inFlight.delete(entry);
			if (sniffer) {
				this._logService.info(`[${this.name}] ${describeUpstreamModel(modelIdentifier, route.modelId, sniffer.model)}`);
			}
		}
	}

	/**
	 * Forwards an upstream failure verbatim, and records why it failed.
	 *
	 * Streaming clients routinely surface a rejected request as a bare status
	 * code — the SDKs read the body only once the stream has started — so the
	 * upstream's own explanation reaches nobody, and a routing- or
	 * parameter-level rejection is indistinguishable from an outage. Buffering
	 * an error body costs nothing (they are small, and the stream never began)
	 * and it is the only place that explanation exists.
	 *
	 * An upstream that answers with an empty body explains nothing on its own, so
	 * the request's own parameters are logged alongside it — a rejection is
	 * almost always one of them. Only the parameters: the conversation, the
	 * instructions and the tool schemas are reduced to shapes, and the request
	 * headers, which carry the credentials, are never read here.
	 */
	private async _forwardUpstreamFailure(response: Response, res: http.ServerResponse, modelId: string, request: Record<string, unknown>): Promise<void> {
		const body = await response.text().catch(() => '');
		const detail = body.length > UPSTREAM_FAILURE_LOG_LIMIT ? `${body.slice(0, UPSTREAM_FAILURE_LOG_LIMIT)}…` : body;
		this._logService.warn(`[${this.name}] upstream rejected model '${modelId}' with ${response.status}: ${detail || '(empty body)'}; sent ${describeUpstreamRequest(request)}`);
		if (res.writableEnded) {
			return;
		}
		const forwarded = toErrorEnvelope(body);
		res.writeHead(response.status, { ...this._responseHeaders(response.headers), 'Content-Length': String(Buffer.byteLength(forwarded)) });
		res.end(forwarded);
	}

	private _authenticate(headers: http.IncomingHttpHeaders, nonce: string): boolean {
		if (parseProxyBearer(headers, nonce).valid) {
			return true;
		}
		const apiKey = headers['x-api-key'];
		return typeof apiKey === 'string' && parseProxyBearer({ authorization: `Bearer ${apiKey}` }, nonce).valid;
	}

	/**
	 * The upstream for `modelIdentifier`, or `undefined` when nothing owns it.
	 *
	 * A `@provider=`-qualified subscription id is host-owned and never reaches the
	 * renderer bridge: the user configured no provider group for it, so asking the
	 * bridge would answer "unknown". Everything else is a BYOK routing id and the
	 * bridge remains the authority for it.
	 *
	 * The id is also where a subscription request carries its service tier, which
	 * becomes a body parameter here: the harness runtime composes the body from a
	 * model id alone and has no other channel to say which tier it wants.
	 */
	private async _resolveRoute(modelIdentifier: string): Promise<IResolvedRoute | undefined> {
		const subscription = parseChatGptSubscriptionModelId(modelIdentifier);
		if (subscription) {
			return {
				modelId: subscription.modelId,
				endpoint: await this._resolveChatGptSubscriptionEndpoint(),
				unsupportedParameters: CHATGPT_SUBSCRIPTION_UNSUPPORTED_PARAMETERS,
				...(subscription.serviceTier ? { bodyParameters: { [CHATGPT_SUBSCRIPTION_SERVICE_TIER_PARAMETER]: subscription.serviceTier } } : {}),
			};
		}
		const provider = await this._bridgeRegistry.resolveProviderConfiguration?.(modelIdentifier);
		return provider ? { modelId: provider.modelId, endpoint: this._resolveEndpoint(provider), unsupportedParameters: [] } : undefined;
	}

	/**
	 * Reads the ChatGPT credentials for this request. They are read per request
	 * rather than cached because the Codex line owns their refresh, so the value
	 * held a moment ago may already have been replaced.
	 */
	private async _resolveChatGptSubscriptionEndpoint(): Promise<IResolvedEndpoint> {
		const credentials = await this._chatGptSubscription.readCredentials();
		return {
			url: CHATGPT_SUBSCRIPTION_RESPONSES_URL,
			apiKey: credentials.accessToken,
			apiType: 'responses',
			providerKind: CHATGPT_SUBSCRIPTION_SOURCE,
			requestHeaders: chatGptSubscriptionUpstreamHeaders(credentials),
		};
	}

	private _resolveEndpoint(provider: IByokLmProviderConfiguration): IResolvedEndpoint {
		if (provider.vendor === 'ollama') {
			const url = typeof provider.configuration.url === 'string' ? provider.configuration.url.trim() : '';
			if (!url) {
				throw new Error(`Ollama provider group '${provider.groupName}' is missing its URL`);
			}
			return {
				url,
				apiKey: '',
				apiType: undefined,
				providerKind: 'ollama',
				requestHeaders: {},
			};
		}
		if (provider.vendor !== 'customendpoint') {
			throw new Error(`Provider '${provider.vendor}' does not expose a native transport`);
		}
		const configuration = provider.configuration;
		const apiKey = typeof configuration.apiKey === 'string' ? configuration.apiKey.trim() : '';
		const models = Array.isArray(configuration.models) ? configuration.models as ICustomEndpointModel[] : [];
		const model = models.find(candidate => candidate.id === provider.modelId);
		const url = typeof model?.url === 'string' ? model.url : typeof configuration.url === 'string' ? configuration.url : '';
		if (!apiKey || !url) {
			throw new Error(`Provider group '${provider.groupName}' is missing its URL or API key`);
		}
		return {
			url,
			apiKey,
			apiType: typeof model?.apiType === 'string' ? model.apiType : typeof configuration.apiType === 'string' ? configuration.apiType : undefined,
			providerKind: typeof configuration.fumieProvider === 'string' ? configuration.fumieProvider : undefined,
			requestHeaders: this._stringHeaders(model?.requestHeaders),
		};
	}

	private _assertWireSupported(endpoint: IResolvedEndpoint, wire: NativeModelWireProtocol): void {
		if (endpoint.providerKind !== 'litellm' && endpoint.apiType && endpoint.apiType !== wire) {
			throw new Error(`Configured endpoint speaks '${endpoint.apiType}', not '${wire}'`);
		}
	}

	private _upstreamUrl(configuredUrl: string, incoming: URL): URL {
		const upstream = new URL(configuredUrl);
		const exactEndpoint = /\/(responses|messages|chat\/completions)$/.test(upstream.pathname);
		if (!exactEndpoint) {
			const basePath = upstream.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
			const requestPath = incoming.pathname.startsWith('/v1/') ? incoming.pathname : `/v1${incoming.pathname}`;
			upstream.pathname = `${basePath}${requestPath}`;
		}
		upstream.search = incoming.search;
		return upstream;
	}

	private _upstreamHeaders(incoming: http.IncomingHttpHeaders, endpoint: IResolvedEndpoint, wire: NativeModelWireProtocol): Headers {
		const result = new Headers();
		for (const [name, value] of Object.entries(incoming)) {
			const lower = name.toLowerCase();
			if (value === undefined || lower === 'host' || lower === 'content-length' || lower === 'authorization' || lower === 'x-api-key' || lower === 'connection') {
				continue;
			}
			result.set(name, Array.isArray(value) ? value.join(', ') : value);
		}
		result.set('Content-Type', 'application/json');
		const configuredHeaders = Object.entries(endpoint.requestHeaders)
			.map(([name, value]) => [name, value.replaceAll('${apiKey}', endpoint.apiKey)] as const);
		const userSuppliedAuth = configuredHeaders.some(([name]) => USER_AUTH_HEADERS.has(name.toLowerCase()));
		if (!userSuppliedAuth) {
			if (endpoint.providerKind === 'ollama') {
				// Local Ollama accepts the OpenAI/Anthropic-compatible endpoints
				// without authentication. Do not forward the loopback nonce.
			} else if (endpoint.providerKind === 'litellm') {
				result.set('Authorization', `Bearer ${endpoint.apiKey}`);
			} else if (wire === 'messages') {
				result.set('x-api-key', endpoint.apiKey);
			} else if (new URL(endpoint.url).hostname.toLowerCase().endsWith('.openai.azure.com')) {
				result.set('api-key', endpoint.apiKey);
			} else {
				result.set('Authorization', `Bearer ${endpoint.apiKey}`);
			}
		}
		if (wire === 'messages' && !result.has('anthropic-version')) {
			result.set('anthropic-version', '2023-06-01');
		}
		for (const [name, value] of configuredHeaders) {
			result.set(name, value);
		}
		return result;
	}

	private _responseHeaders(headers: Headers): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [name, value] of headers) {
			// fetch transparently decompresses upstream bodies. Forwarding the old
			// content-encoding would make the native client decompress a second time.
			if (name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'content-encoding' && name.toLowerCase() !== 'connection') {
				result[name] = value;
			}
		}
		return result;
	}

	private _stringHeaders(value: unknown): Readonly<Record<string, string>> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}
		return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
	}

	private _writeModels(res: http.ServerResponse, models: readonly IByokLmModelInfo[]): void {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ object: 'list', data: models.map(model => ({ id: model.modelIdentifier ?? `${model.vendor}/${model.id}`, object: 'model' })) }));
	}

	private _writeError(res: http.ServerResponse, status: number, message: string): void {
		if (res.headersSent || res.writableEnded) {
			return;
		}
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
	}
}

/**
 * Restates an error body under the `error.message` key its reader looks for.
 *
 * The OpenAI SDKs read a failure only out of `{"error":{"message":…}}`; given
 * any other shape they discard the body and report a bare status, which is how
 * a perfectly explicit `{"detail":"Unsupported parameter: max_output_tokens"}`
 * reached the user as "400 status code (no body)". Forwarding the bytes is not
 * enough when the envelope is what the reader keys on.
 *
 * Narrow by construction: it acts only on an object carrying a string `detail`
 * and no `error`, which no OpenAI- or Anthropic-shaped upstream returns, and it
 * keeps the original fields alongside. Anything else is passed through byte for
 * byte.
 */
function toErrorEnvelope(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return body;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return body;
	}
	const candidate = parsed as { detail?: unknown; error?: unknown };
	if (candidate.error !== undefined || typeof candidate.detail !== 'string') {
		return body;
	}
	return JSON.stringify({ ...candidate, error: { type: 'invalid_request_error', message: candidate.detail } });
}

/**
 * The request's parameters, for a log line that has to explain a rejection the
 * upstream did not explain itself.
 *
 * Parameters are what get rejected, so they are reported verbatim. The payload
 * — the conversation, the system prompt, the tool schemas — is reduced to its
 * shape: it is large, it is the user's, and it is never the thing a 400 is
 * about.
 */
function describeUpstreamRequest(request: Record<string, unknown>): string {
	const described: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(request)) {
		if (name === 'input' || name === 'messages') {
			described[name] = `<${Array.isArray(value) ? value.length : 1} item(s)>`;
		} else if (name === 'instructions' || name === 'system') {
			described[name] = `<${typeof value === 'string' ? value.length : 0} chars>`;
		} else if (name === 'tools') {
			described[name] = Array.isArray(value)
				? value.map(tool => (tool as { name?: unknown })?.name ?? (tool as { type?: unknown })?.type ?? '?')
				: '<tools>';
		} else {
			described[name] = value;
		}
	}
	return JSON.stringify(described);
}

/**
 * Reads the model an upstream says answered a request, from a bounded prefix of
 * its successful response.
 *
 * A gateway routes to a backend of its own choosing, so the model id we sent is
 * our label for the route, not a statement about what ran. The response is the
 * only place the upstream speaks for itself: an Anthropic stream names it on
 * `message_start`, an OpenAI Responses stream on `response.created`, a Chat
 * Completions stream on its first chunk, and a non-streamed body at the top
 * level ahead of its content. All of those land inside
 * {@link UPSTREAM_MODEL_SNIFF_LIMIT} bytes.
 *
 * Inspection never touches the bytes on their way to the client: chunks are
 * observed only after they have been written, nothing is held back, and the
 * prefix is dropped as soon as the model is known or the cap is reached.
 */
export class UpstreamModelSniffer {

	private _prefix: Buffer = Buffer.alloc(0);
	private _model: string | undefined;
	private _settled = false;

	/** The model the upstream reported, or `undefined` if it reported none. */
	get model(): string | undefined {
		return this._model;
	}

	observe(chunk: Buffer): void {
		if (this._settled) {
			return;
		}
		this._prefix = Buffer.concat([this._prefix, chunk], Math.min(this._prefix.length + chunk.length, UPSTREAM_MODEL_SNIFF_LIMIT));
		this._model = readUpstreamModel(this._prefix.toString('utf8'));
		if (this._model !== undefined || this._prefix.length >= UPSTREAM_MODEL_SNIFF_LIMIT) {
			this._settled = true;
			this._prefix = Buffer.alloc(0);
		}
	}
}

/**
 * The model named in a response prefix, across the SSE and plain-JSON shapes
 * this proxy forwards, or `undefined` when the prefix names none yet.
 */
export function readUpstreamModel(prefix: string): string | undefined {
	for (const payload of jsonPayloads(prefix)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			// A frame still arriving, or a `[DONE]` sentinel. Skip it.
			continue;
		}
		const model = readModelField(parsed);
		if (model !== undefined) {
			return model;
		}
	}
	// Nothing parsed yet — the body is mid-flight. Every shape puts the
	// answering model ahead of its content, so the first one named is it.
	const match = /"model"\s*:\s*"([^"\\]*)"/.exec(prefix);
	return match && match[1].length > 0 ? match[1] : undefined;
}

/** The JSON documents in a response prefix: SSE `data:` frames, or the body. */
function jsonPayloads(prefix: string): string[] {
	if (!prefix.includes('data:')) {
		return [prefix];
	}
	const payloads: string[] = [];
	for (const line of prefix.split('\n')) {
		if (line.startsWith('data:')) {
			payloads.push(line.slice('data:'.length).trim());
		}
	}
	return payloads;
}

/** `model` wherever the three wire shapes carry it on their opening document. */
function readModelField(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const candidate = payload as { model?: unknown; message?: { model?: unknown }; response?: { model?: unknown } };
	for (const value of [candidate.model, candidate.message?.model, candidate.response?.model]) {
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * One line per request saying what we asked for and what answered, so a
 * gateway that silently substitutes a backend model is visible.
 *
 * Only the model ids appear here. The response body, the request headers and
 * the credentials they carry are never read for this.
 */
export function describeUpstreamModel(routingId: string, sentModelId: string, reported: string | undefined): string {
	const sent = routingId === sentModelId ? `'${sentModelId}'` : `'${sentModelId}' (routed from '${routingId}')`;
	if (reported === undefined) {
		return `upstream model: sent ${sent}, upstream reported none`;
	}
	return `upstream model: sent ${sent}, upstream reported '${reported}' (${reported === sentModelId ? 'same' : 'differs'})`;
}

export class NullNativeModelProviderProxyService implements INativeModelProviderProxyService {

	declare readonly _serviceBrand: undefined;

	start(): Promise<INativeModelProviderProxyHandle> {
		return Promise.reject(new Error('Native model providers are not available in this agent host'));
	}

	dispose(): void { }
}
