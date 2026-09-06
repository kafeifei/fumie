/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Lets a native harness run the user's ChatGPT subscription models.
 *
 * The credentials are not ours: they belong to the Codex line, which signs the
 * user in and keeps the access token fresh. This module is only the borrowing
 * end — one source registers (the Codex agent), and the harnesses that want a
 * subscription model read from it. Nothing here refreshes, stores or writes a
 * token, so there is never a second writer racing Codex for the refresh token.
 */

/**
 * Source token in the `@provider=<source>:<id>` model ids a harness advertises
 * for ChatGPT subscription models. The qualification keeps them out of the BYOK
 * id space, whose ids are `<vendor>/<model>` and are split on the first `/`.
 */
export const CHATGPT_SUBSCRIPTION_SOURCE = 'chatgpt-subscription';

/**
 * Inference endpoint for a ChatGPT subscription. Note this is the ChatGPT
 * backend, not `api.openai.com`: the subscription is billed there, and the API
 * host would bill an API key instead.
 */
export const CHATGPT_SUBSCRIPTION_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Codex CLI version reported in `User-Agent` when the product carries no Codex
 * SDK version (development checkouts, where `product.agentSdks` is not stamped).
 */
export const CHATGPT_SUBSCRIPTION_FALLBACK_CLIENT_VERSION = '0.153.4';

/**
 * A speed tier the backend publishes for a model, selected with the
 * `service_tier` body parameter. A model that publishes none runs at whatever
 * the backend serves when the parameter is absent.
 */
export interface IChatGptSubscriptionServiceTier {
	/** Tier id the backend expects, e.g. `priority`. */
	readonly id: string;
	/** Upstream's own name for the tier, shown to the user as published. */
	readonly name: string;
	/** Upstream's own blurb for the tier, shown to the user as published. */
	readonly description: string;
}

/** Model the harness may run on a ChatGPT subscription. */
export interface IChatGptSubscriptionModel {
	/** Model id as the ChatGPT backend knows it, e.g. `gpt-5.5`. */
	readonly id: string;
	readonly name: string;
	readonly maxContextWindowTokens: number;
	readonly supportsVision: boolean;
	/**
	 * Reasoning efforts upstream accepts. A harness narrows this to the levels
	 * it has a vocabulary for; upstream levels beyond that are simply not
	 * offered rather than translated into a neighbouring one.
	 */
	readonly supportedReasoningEfforts: readonly string[];
	readonly defaultReasoningEffort: string;
	/**
	 * Speed tiers upstream publishes for this model, beyond the default one it
	 * serves with no `service_tier` at all. Absent for a model that publishes
	 * none: there is nothing to offer, not a tier we failed to transcribe.
	 */
	readonly serviceTiers?: readonly IChatGptSubscriptionServiceTier[];
}

/**
 * Ceiling on a single response, bounded further by the model's context window.
 *
 * Not an upstream fact: the endpoint publishes no output limit and refuses
 * `max_output_tokens` outright (see
 * {@link CHATGPT_SUBSCRIPTION_UNSUPPORTED_PARAMETERS}), so this never reaches
 * the backend. It exists because a harness needs some number to clamp its own
 * bookkeeping against, and one deliberately generous value serves every model:
 * inventing a different figure per model would dress a guess up as data.
 */
const CHATGPT_SUBSCRIPTION_MAX_OUTPUT_TOKENS = 128_000;

/** {@link CHATGPT_SUBSCRIPTION_MAX_OUTPUT_TOKENS} kept inside `model`'s window. */
export function chatGptSubscriptionMaxOutputTokens(model: IChatGptSubscriptionModel): number {
	return Math.min(CHATGPT_SUBSCRIPTION_MAX_OUTPUT_TOKENS, model.maxContextWindowTokens);
}

/**
 * The non-default tier most of the published catalog carries, transcribed from
 * the same read as {@link CHATGPT_SUBSCRIPTION_MODELS}. The name and blurb are
 * upstream's own wording and are shown to the user unchanged: a tier renamed
 * here would promise something the backend never agreed to.
 */
const CHATGPT_SUBSCRIPTION_PRIORITY_TIER: IChatGptSubscriptionServiceTier = {
	id: 'priority',
	name: 'Fast',
	description: '1.5x speed, increased usage',
};

/**
 * The same `priority` tier as {@link CHATGPT_SUBSCRIPTION_PRIORITY_TIER}, with
 * the blurb the catalog publishes for `gpt-6-astra` alone. Upstream quotes a
 * different multiplier there, so the two cannot share one constant: reusing the
 * 1.5x wording would understate what that model's tier was sold as.
 */
const CHATGPT_SUBSCRIPTION_PRIORITY_TIER_2X: IChatGptSubscriptionServiceTier = {
	id: 'priority',
	name: 'Fast',
	description: '2x speed, increased usage',
};

/**
 * The subscription models a harness offers.
 *
 * The list is the user-facing part of what the Codex backend publishes to a
 * signed-in account: models it marks hidden (`gpt-reserve`, `codex-auto-review`)
 * are internal plumbing — a reserve pool and the automatic approval reviewer —
 * and Codex itself enumerates without them, so a harness has no business
 * offering them as something to chat with.
 *
 * The metadata is transcribed from that same published catalog (Codex's model
 * cache, read once on 2026-09-05, client version 0.153.4), never estimated: a
 * guessed figure here is what the backend rejects the whole request over.
 *
 * What the backend publishes still is not what it will run. It routes on the
 * `originator` header, and cohorts exist in which a listed model is not
 * reachable under the Codex originator, so a model that fails end to end comes
 * back out of this list rather than staying in it hopefully.
 */
export const CHATGPT_SUBSCRIPTION_MODELS: readonly IChatGptSubscriptionModel[] = [
	{
		id: 'gpt-6-astra',
		name: 'GPT-6-Astra',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		defaultReasoningEffort: 'medium',
		serviceTiers: [CHATGPT_SUBSCRIPTION_PRIORITY_TIER_2X],
	},
	{
		id: 'gpt-5.6-sol',
		name: 'GPT-5.6-Sol',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		defaultReasoningEffort: 'low',
		serviceTiers: [CHATGPT_SUBSCRIPTION_PRIORITY_TIER],
	},
	{
		id: 'gpt-5.6-terra',
		name: 'GPT-5.6-Terra',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		defaultReasoningEffort: 'medium',
		serviceTiers: [CHATGPT_SUBSCRIPTION_PRIORITY_TIER],
	},
	{
		id: 'gpt-5.6-luna',
		name: 'GPT-5.6-Luna',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		defaultReasoningEffort: 'medium',
		serviceTiers: [CHATGPT_SUBSCRIPTION_PRIORITY_TIER],
	},
	{
		id: 'gpt-5.5',
		name: 'GPT-5.5',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
		defaultReasoningEffort: 'medium',
		serviceTiers: [CHATGPT_SUBSCRIPTION_PRIORITY_TIER],
	},
	{
		id: 'gpt-5.4',
		name: 'GPT-5.4',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
		defaultReasoningEffort: 'medium',
		serviceTiers: [CHATGPT_SUBSCRIPTION_PRIORITY_TIER],
	},
	{
		id: 'gpt-5.4-mini',
		name: 'GPT-5.4-Mini',
		maxContextWindowTokens: 272_000,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
		defaultReasoningEffort: 'medium',
	},
	{
		id: 'gpt-5.3-codex-spark',
		name: 'GPT-5.3-Codex-Spark',
		maxContextWindowTokens: 128_000,
		supportsVision: false,
		supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
		defaultReasoningEffort: 'high',
	},
];

/**
 * Body parameters the ChatGPT backend rejects outright, with
 * `{"detail":"Unsupported parameter: …"}` and no partial acceptance.
 *
 * This endpoint is not the Responses API: it is a narrower surface serving one
 * client, so a parameter being valid Responses input says nothing about whether
 * it is accepted here. A harness that sets a ceiling on its own output —
 * reasonable everywhere else — sends `max_output_tokens` and is refused.
 *
 * Entries are added when an upstream rejection names them, never pre-emptively:
 * removing a parameter the endpoint would have honoured silently changes what
 * the model was asked for.
 */
export const CHATGPT_SUBSCRIPTION_UNSUPPORTED_PARAMETERS: readonly string[] = ['max_output_tokens'];

/** Body parameter the ChatGPT backend reads a {@link IChatGptSubscriptionServiceTier} from. */
export const CHATGPT_SUBSCRIPTION_SERVICE_TIER_PARAMETER = 'service_tier';

/** How a service tier is spelled inside a qualified model id. */
const CHATGPT_SUBSCRIPTION_SERVICE_TIER_SUFFIX = '?serviceTier=';

/** What one request runs: which model, and at which tier. */
export interface IChatGptSubscriptionModelRoute {
	/** Model id as the ChatGPT backend knows it, e.g. `gpt-5.5`. */
	readonly modelId: string;
	/**
	 * Tier to ask for, or `undefined` to send no `service_tier` at all and take
	 * the backend's default.
	 */
	readonly serviceTier?: string;
}

/**
 * The provider-qualified model id a harness advertises for `modelId`.
 *
 * A non-default `serviceTier` rides along inside the id because the id is the
 * only thing that reaches the request: a harness hands its runtime one model
 * and the runtime composes the body itself, so the tier travels as part of the
 * id and {@link parseChatGptSubscriptionModelId} turns it back into a body
 * parameter at the proxy. The ids a harness *lists* never carry one — the tier
 * is a per-request choice from the model's config, not a separate model.
 */
export function chatGptSubscriptionAgentModelId(modelId: string, serviceTier?: string): string {
	const tier = serviceTier ? `${CHATGPT_SUBSCRIPTION_SERVICE_TIER_SUFFIX}${serviceTier}` : '';
	return `@provider=${CHATGPT_SUBSCRIPTION_SOURCE}:${modelId}${tier}`;
}

/**
 * What an id produced by {@link chatGptSubscriptionAgentModelId} routes to, or
 * `undefined` for any other id.
 */
export function parseChatGptSubscriptionModelId(agentModelId: string): IChatGptSubscriptionModelRoute | undefined {
	const prefix = `@provider=${CHATGPT_SUBSCRIPTION_SOURCE}:`;
	if (!agentModelId.startsWith(prefix)) {
		return undefined;
	}
	const qualified = agentModelId.slice(prefix.length);
	const separator = qualified.indexOf(CHATGPT_SUBSCRIPTION_SERVICE_TIER_SUFFIX);
	const modelId = separator === -1 ? qualified : qualified.slice(0, separator);
	if (!modelId) {
		return undefined;
	}
	const serviceTier = separator === -1 ? '' : qualified.slice(separator + CHATGPT_SUBSCRIPTION_SERVICE_TIER_SUFFIX.length);
	return serviceTier ? { modelId, serviceTier } : { modelId };
}

/** What one upstream request needs to reach the ChatGPT backend as Codex does. */
export interface IChatGptSubscriptionCredentials {
	/** Current ChatGPT access token. The owning source keeps it fresh. */
	readonly accessToken: string;
	/** Workspace/account the token belongs to, sent as `ChatGPT-Account-ID`. */
	readonly accountId: string;
	/** Codex CLI version this host reports, which pairs with the originator. */
	readonly clientVersion: string;
}

/**
 * Extra request headers the ChatGPT backend requires. It only serves clients it
 * recognizes as Codex, so the originator and its matching `User-Agent` are not
 * decoration: a request identifying itself as anything else is rejected.
 */
export function chatGptSubscriptionUpstreamHeaders(credentials: IChatGptSubscriptionCredentials): Record<string, string> {
	return {
		'originator': 'codex_cli_rs',
		'User-Agent': `codex_cli_rs/${credentials.clientVersion}`,
		// PascalCase is what the backend matches on.
		'ChatGPT-Account-ID': credentials.accountId,
		'OpenAI-Beta': 'responses=experimental',
	};
}

/**
 * The account the access token was issued for, read from its own claims.
 *
 * The id is not returned alongside the token by the app-server, and taking it
 * from `auth.json` instead would let the two drift apart after a refresh. It is
 * a claim of the token itself, so reading it here keeps them one value.
 * Returns `undefined` for anything that is not a ChatGPT access token.
 */
export function chatGptAccountIdFromAccessToken(accessToken: string): string | undefined {
	const payload = accessToken.split('.')[1];
	if (!payload) {
		return undefined;
	}
	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
	const auth = (claims as { 'https://api.openai.com/auth'?: unknown })?.['https://api.openai.com/auth'];
	const accountId = (auth as { chatgpt_account_id?: unknown })?.chatgpt_account_id;
	return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

/**
 * The single owner of the user's ChatGPT credentials. Implemented by the Codex
 * agent, which already signs the user in and refreshes the token.
 */
export interface IChatGptSubscriptionSource {
	/** Fires when {@link isSignedIn} may have changed. */
	readonly onDidChangeSignedIn: Event<void>;
	/** Synchronous, so a model catalog can be built without I/O. */
	isSignedIn(): boolean;
	/** The credentials for the next upstream request. Rejects when there are none. */
	readCredentials(): Promise<IChatGptSubscriptionCredentials>;
}

export const IChatGptSubscriptionService = createDecorator<IChatGptSubscriptionService>('chatGptSubscriptionService');

export interface IChatGptSubscriptionService {
	readonly _serviceBrand: undefined;
	/** Fires when {@link isSignedIn} may have changed, including on (de)registration. */
	readonly onDidChangeSignedIn: Event<void>;
	/** Registers the credential owner. Disposing the result removes it. */
	registerSource(source: IChatGptSubscriptionSource): IDisposable;
	/** Whether a ChatGPT subscription is signed in and can serve inference. */
	isSignedIn(): boolean;
	/** The credentials for the next upstream request. Rejects when there are none. */
	readCredentials(): Promise<IChatGptSubscriptionCredentials>;
}

export class ChatGptSubscriptionService extends Disposable implements IChatGptSubscriptionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSignedIn = this._register(new Emitter<void>());
	readonly onDidChangeSignedIn = this._onDidChangeSignedIn.event;

	private readonly _sourceListener = this._register(new MutableDisposable());
	private _source: IChatGptSubscriptionSource | undefined;

	registerSource(source: IChatGptSubscriptionSource): IDisposable {
		this._source = source;
		this._sourceListener.value = source.onDidChangeSignedIn(() => this._onDidChangeSignedIn.fire());
		this._onDidChangeSignedIn.fire();
		return toDisposable(() => {
			if (this._source === source) {
				this._source = undefined;
				this._sourceListener.clear();
				this._onDidChangeSignedIn.fire();
			}
		});
	}

	isSignedIn(): boolean {
		return this._source?.isSignedIn() === true;
	}

	async readCredentials(): Promise<IChatGptSubscriptionCredentials> {
		if (!this._source) {
			throw new Error('No ChatGPT subscription is available in this agent host.');
		}
		return this._source.readCredentials();
	}
}
