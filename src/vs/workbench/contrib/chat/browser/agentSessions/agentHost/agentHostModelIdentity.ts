/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentModelMatchesRawId } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { ILanguageModelChatMetadata } from '../../../common/languageModels.js';

/**
 * Translates between the identifier a picker row carries and the model id the
 * agent behind it published.
 *
 * A picker identifier is `{vendor}:{agent model id}` (see
 * `AgentHostLanguageModelProvider`). For a long time the vendor was always the
 * session's own chat session type, so both directions could be done by pasting
 * or slicing that one literal prefix. That is no longer true: a provider may
 * publish an agent's models under a vendor of its own while keeping the agent's
 * `targetChatSessionType` — which is what routes the model — so the vendor half
 * of the identifier no longer names the session.
 *
 * A prefix comparison then fails silently and hands the agent a string like
 * `codex-subscription:@provider=openai:gpt-5.6-sol`, which the agent correctly
 * reports as an unknown model. Slicing at the first colon regardless is not the
 * fix either: agent model ids contain colons of their own
 * (`@provider=openai:gpt-5.6-sol`), so a bare id would be truncated.
 *
 * The registered model is the authority instead. Its `metadata.id` is verbatim
 * what the agent published, and `metadata.targetChatSessionType` says which
 * session it is for, so neither function has to know any vendor's name.
 */
export type AgentHostModelLookup = (identifier: string) => ILanguageModelChatMetadata | undefined;

/**
 * The agent's own model id behind `identifier`, for a session of `sessionType`.
 *
 * Falls back to the historical prefix strip when the model is not registered —
 * a selection persisted by an earlier run, resolved before the providers have
 * published — and to the identifier unchanged when even that does not apply,
 * which is how a bare id (already the agent's own) passes through.
 */
export function agentModelIdFromIdentifier(identifier: string, sessionType: string, lookup: AgentHostModelLookup): string {
	const metadata = lookup(identifier);
	if (metadata?.targetChatSessionType === sessionType) {
		return metadata.id;
	}
	const prefix = `${sessionType}:`;
	return identifier.startsWith(prefix) ? identifier.slice(prefix.length) : identifier;
}

/**
 * The reverse: the identifier a picker row for `agentModelId` carries, so a
 * model the agent reports as running can be matched back to the row that
 * selects it.
 *
 * `candidates` are every registered model. The one that serves this session and
 * published this id wins whatever vendor it belongs to; without that, a model
 * offered only by a subscription provider would be named under the agent's own
 * vendor, where no such row exists.
 *
 * The same model can be registered twice — once by the agent's own vendor, which
 * registers everything the agent can run but hides the subscription rows, and
 * once by the subscription provider the user added, which offers them. A row the
 * user can actually see wins, so the selection points at the row that selects it;
 * the hidden registration is the answer only while no visible one exists, which
 * is what keeps the model resolvable (context window, session restore) for a user
 * who never added the subscription.
 *
 * `agentModelId` may also be the bare id the agent's runtime reports rather than
 * the decorated id the row is published under — a turn replayed from a
 * transcript has no other name for its model. Such a row is matched by its
 * {@link ILanguageModelChatMetadata.underlyingModelId}, but only after every
 * exact `id` match has been ruled out: two rows can share one underlying model
 * (the same model via two providers), so the id the caller actually named is
 * always the better answer when it is registered.
 *
 * A bare id genuinely can name more than one row — a subscription's
 * `@provider=anthropic:claude-fable-5[1m]` and a BYOK provider's
 * `customendpoint/Example/claude-fable-5` both run `claude-fable-5`. `sessionModelId`
 * is the model the session is actually on, and it settles that: it is the row
 * that ran the turn, whatever else answers to the same underlying id. Without it
 * the answer must be unambiguous or there is none — naming some other user's
 * provider as the one that ran a turn is worse than naming none, since the
 * identifier is also what a reopened session restores its model from.
 *
 * A BYOK bridge row cannot be reached by the underlying-id match at all — see
 * the note at the comparison — so a user's own endpoint cannot claim a run the
 * harness served natively. It stays reachable as the id it is published under,
 * and as the session's own model when the session really is on it.
 */
export function identifierForAgentModelId(
	agentModelId: string,
	sessionType: string,
	candidates: Iterable<{ readonly identifier: string; readonly metadata: ILanguageModelChatMetadata }>,
	sessionModelId?: string,
): string {
	return resolveIdentifierForAgentModelId(agentModelId, sessionType, candidates, sessionModelId).identifier;
}

/**
 * What {@link identifierForAgentModelId} answered, plus whether the answer came
 * from the catalog at all.
 *
 * `fabricated` marks the last-resort `${sessionType}:${id}` shape: a plausible
 * identifier that nothing is registered under, so anything that resolves it
 * (context window, display name, the picker row) comes back empty. The catalog
 * is filled in asynchronously, one vendor at a time, so a caller that resolves
 * at session-open time can be told "not registered" purely because it asked
 * early. Callers that can afford to ask again read this and re-resolve when the
 * catalog changes; callers that only need something to hand downstream keep
 * using {@link identifierForAgentModelId} and ignore it.
 */
export interface IAgentModelIdentifierResolution {
	readonly identifier: string;
	/** True when nothing in the catalog matched and the identifier was composed. */
	readonly fabricated: boolean;
}

/** {@link identifierForAgentModelId}, with the fabricated-vs-resolved fact kept. */
export function resolveIdentifierForAgentModelId(
	agentModelId: string,
	sessionType: string,
	candidates: Iterable<{ readonly identifier: string; readonly metadata: ILanguageModelChatMetadata }>,
	sessionModelId?: string,
): IAgentModelIdentifierResolution {
	const prefix = `${sessionType}:`;
	if (agentModelId.startsWith(prefix)) {
		// Already an identifier for this session; the caller's own literal is
		// the answer whatever the catalog holds, so re-asking cannot change it.
		return { identifier: agentModelId, fabricated: false };
	}
	// Best answer first: the id the caller named, then the session's own model,
	// then a row that merely runs the same underlying model — and within each, a
	// row the user can pick beats one registered only as fact. Nothing can return
	// early: a better match may still be further down the catalog, and an
	// underlying match is only an answer while it stays the only one.
	let selectable: string | undefined;
	let hidden: string | undefined;
	let sessionModel: string | undefined;
	const selectableByUnderlying: string[] = [];
	const hiddenByUnderlying: string[] = [];
	for (const candidate of candidates) {
		const { metadata } = candidate;
		if (metadata.targetChatSessionType !== sessionType || !agentModelMatchesRawId(metadata, agentModelId)) {
			continue;
		}
		if (metadata.id === agentModelId) {
			if (metadata.isUserSelectable !== false) {
				selectable ??= candidate.identifier;
			} else {
				hidden ??= candidate.identifier;
			}
			continue;
		}
		if (metadata.id === sessionModelId) {
			// The session is demonstrably on this row, so it is the answer even
			// when only its underlying id matches.
			sessionModel ??= candidate.identifier;
			continue;
		}
		// A BYOK bridge row is a projection of an endpoint the *user* configured,
		// mirrored into the harness's pool; its `underlyingModelId` is that
		// endpoint's own name for the model, which routinely collides with the
		// harness's native name for a different transport — a Claude session
		// serving `claude-fable-5` through Anthropic and a user's
		// OpenAI-compatible proxy publishing `claude-fable-5` are two different
		// runs of two different services under one string. Matching a reported id
		// against that projection therefore names a provider the turn may never
		// have touched, which is how a footer ends up crediting some third-party
		// endpoint (or, in a Codex pool, a model from an unrelated vendor) for
		// work it did not do. Only the id such a row is *published* under
		// identifies it; the underlying id it shares does not.
		if (metadata.byokModelIdentifier !== undefined) {
			continue;
		}
		if (metadata.isUserSelectable !== false) {
			selectableByUnderlying.push(candidate.identifier);
		} else {
			hiddenByUnderlying.push(candidate.identifier);
		}
	}
	const resolved = selectable ?? hidden ?? sessionModel ?? onlyOne(selectableByUnderlying) ?? onlyOne(hiddenByUnderlying);
	return resolved
		? { identifier: resolved, fabricated: false }
		: { identifier: `${prefix}${agentModelId}`, fabricated: true };
}

/** The sole identifier in `identifiers`, or none when the id named several rows. */
function onlyOne(identifiers: readonly string[]): string | undefined {
	return identifiers.length === 1 ? identifiers[0] : undefined;
}
