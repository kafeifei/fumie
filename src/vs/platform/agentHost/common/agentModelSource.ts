/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AGENT_PROVIDER_ID, CODEX_AGENT_PROVIDER_ID, type IAgentModelInfo } from './agent.js';
import { CLAUDE_PROVIDER_ANTHROPIC } from './claudeProviders.js';
import type { SessionModelInfo } from './state/protocol/state.js';

/** Well-known source id for models provided by a user's ChatGPT subscription. */
export const CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID = 'chatgptSubscription';

/**
 * Catalog slugs of the ACP connector's agents.
 *
 * A slug doubles as the source id of every model that agent publishes, which is
 * how the picker resolves a group of ACP models to the agent behind them. They
 * live here rather than in the (node-only) catalog because the presentation
 * side of that lookup is registered in the workbench.
 */
export const ACP_CLAUDE_AGENT_SLUG = 'claude-acp';

/** Well-known key carrying a model's source id under its open `_meta` bag. */
export const AGENT_MODEL_SOURCE_ID_META_KEY = 'modelSourceId';

/**
 * Builds a `_meta` payload carrying a model source id, or `undefined` when the
 * producer cannot confidently identify the source.
 */
export function createAgentModelSourceMeta(sourceId: string | undefined): Record<string, unknown> | undefined {
	return sourceId !== undefined ? { [AGENT_MODEL_SOURCE_ID_META_KEY]: sourceId } : undefined;
}

/** Reads a model source id from the open `_meta` bag, ignoring invalid values. */
export function readAgentModelSourceId(model: IAgentModelInfo | SessionModelInfo): string | undefined {
	const meta = model._meta;
	if (!meta) {
		return undefined;
	}
	const value = meta[AGENT_MODEL_SOURCE_ID_META_KEY];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A published catalog row, seen only as the two ids it can be named by: the id
 * it is published under and, when the two differ, the raw id its agent's
 * runtime reports. Structural so the same match works on a `SessionModelInfo`
 * from root state and on the language-model metadata built from it.
 */
export interface IAgentModelIdentity {
	readonly id: string;
	readonly underlyingModelId?: string;
}

/**
 * Whether `model` is the catalog row a runtime-reported model id names.
 *
 * A model id crosses two namespaces: the catalog publishes what a picker row
 * selects (possibly decorated — `@provider=anthropic:claude-opus-4-8`,
 * `myvendor/claude-opus-4-8`), while transcripts and usage report the bare id
 * the runtime actually ran (`claude-opus-4-8`). Comparing one against the other
 * with `===` never matches, so anything keyed by a reported id — the context
 * window behind the usage gauge, the model name on a replayed turn — comes back
 * empty. Matching either id is the translation between the two namespaces, and
 * it lives here so a catalog's id shape can evolve without every consumer
 * learning to parse it.
 *
 * A trailing bracketed suffix on the underlying id is part of that decoration:
 * `claude-fable-5[1m]` names the window a session is opened with, not a model of
 * its own, so the runtime reports `claude-fable-5` for it. Only the catalog side
 * is undecorated — a reported id is taken verbatim.
 *
 * Matching is deliberately not a unique key: two providers can offer the same
 * underlying model, so a caller that has to name exactly one row (which provider
 * ran this turn) must break the tie itself rather than take the first match.
 */
export function agentModelMatchesRawId(model: IAgentModelIdentity, rawModelId: string): boolean {
	if (model.id === rawModelId || model.underlyingModelId === rawModelId) {
		return true;
	}
	return model.underlyingModelId !== undefined
		&& model.underlyingModelId.replace(/\[[^\]]*\]$/, '') === rawModelId;
}

/**
 * The one model in `models` that a runtime-reported id names, or none.
 *
 * The id a row is published under is the caller's own word for it, so an exact
 * `id` wins outright. Everything else is a claim about the same underlying
 * model, and several rows can make it at once — a subscription and a BYOK
 * provider both routing `claude-fable-5`. Answering with the first of those
 * would attribute a turn, a context window, or a name to a provider the user
 * never ran, so an ambiguous id names nothing and the caller falls back to
 * whatever it knows about the session itself.
 *
 * The picker-facing lookup (`resolveIdentifierForAgentModelId`) layers
 * row visibility and the session's own model over this same rule; it refuses
 * ambiguity for the same reason.
 */
export function resolveAgentModelByRawId<T extends IAgentModelIdentity>(models: readonly T[], rawModelId: string): T | undefined {
	const exact = models.filter(model => model.id === rawModelId);
	if (exact.length > 0) {
		return exact.length === 1 ? exact[0] : undefined;
	}
	const byUnderlying = models.filter(model => agentModelMatchesRawId(model, rawModelId));
	return byUnderlying.length === 1 ? byUnderlying[0] : undefined;
}

/** Well-known key carrying a model's picker-group vendor id under its open `_meta` bag. */
export const AGENT_MODEL_GROUP_ID_META_KEY = 'modelGroupId';

/**
 * Builds a `_meta` payload carrying a model's picker-group vendor id.
 *
 * A producer stamps this when a model's owning agent provider (used for session
 * routing) differs from the vendor its picker group should resolve under — e.g.
 * a Claude model is owned by the `claude` agent but groups under `copilot` or
 * `anthropic` by its transport. Keeping the group id in `_meta` leaves
 * {@link IAgentModelInfo.provider} free to stay the routing owner.
 */
export function createAgentModelGroupMeta(groupId: string): Record<string, unknown> {
	return { [AGENT_MODEL_GROUP_ID_META_KEY]: groupId };
}

/** Reads a model's picker-group vendor id from the open `_meta` bag, ignoring invalid values. */
export function readAgentModelGroupId(model: IAgentModelInfo | SessionModelInfo): string | undefined {
	const meta = model._meta;
	if (!meta) {
		return undefined;
	}
	const value = meta[AGENT_MODEL_GROUP_ID_META_KEY];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Whether `model` is one an agent publishes on behalf of a first-party
 * subscription the user signs in to with a CLI, rather than one it projects from
 * a gateway or a BYOK catalog.
 *
 * The two agents mark their subscription rows differently because their catalogs
 * are built differently, and both marks predate this question: Claude's merged
 * catalog stamps each model's transport as its picker-group id, so the native
 * BYO-Anthropic half is exactly the `anthropic` group; Codex only lists
 * app-server models at all for a ChatGPT account and stamps them with that
 * source id. Reading them through one function is what lets the subscription
 * providers and the agent's own registration agree on which rows are whose
 * without either side restating the rule.
 */
export function isSubscriptionCatalogModel(agentProvider: string, model: IAgentModelInfo | SessionModelInfo): boolean {
	switch (agentProvider) {
		case CLAUDE_AGENT_PROVIDER_ID:
			return readAgentModelGroupId(model) === CLAUDE_PROVIDER_ANTHROPIC;
		case CODEX_AGENT_PROVIDER_ID:
			return readAgentModelSourceId(model) === CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID;
		default:
			return false;
	}
}
