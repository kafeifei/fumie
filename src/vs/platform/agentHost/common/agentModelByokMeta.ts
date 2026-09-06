/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionModelInfo } from './state/protocol/state.js';
import type { IAgentModelInfo } from './agent.js';

/**
 * Well-known key for the renderer LM-service identifier of the BYOK model an
 * agent-host model is a copy of, carried under a model's open `_meta` bag (see
 * {@link IAgentModelInfo._meta} / {@link SessionModelInfo._meta}).
 *
 * A renderer BYOK model is registered under `<vendor>/<group>/<id>` (or `<vendor>/<id>`
 * without a configured group) — exactly the id the "Manage Models" view keys visibility
 * by. That identifier is not otherwise recoverable once the model round-trips the
 * agent-host bridge, so the renderer attaches it here so the chat model picker can honour
 * the model's visibility toggle.
 */
export const BYOK_MODEL_IDENTIFIER_META_KEY = 'byokModelIdentifier';

/**
 * Well-known key marking a BYOK model the host's serving window has hidden in its own
 * "Manage Models" page, carried under the same open `_meta` bag.
 *
 * Only set when hidden, and only by the host: it is the host's visibility state, not the
 * reading client's. A client that reaches the catalog only through a host — the Agents
 * window in a browser — has no other copy of that state, so without this key it cannot
 * tell a hidden row from one the user never configured. Absent means "not hidden by the
 * host", which is also what an older host says by saying nothing.
 */
export const BYOK_MODEL_HIDDEN_META_KEY = 'byokModelHidden';

/**
 * Builds a `_meta` payload carrying the BYOK model identifier and, when the serving
 * window has the model hidden, the hidden marker. Returns `undefined` when there is
 * nothing to carry so callers can avoid attaching an empty `_meta` object.
 */
export function createAgentModelByokMeta(modelIdentifier: string | undefined, hidden?: boolean): Record<string, unknown> | undefined {
	if (modelIdentifier === undefined) {
		return undefined;
	}
	return {
		[BYOK_MODEL_IDENTIFIER_META_KEY]: modelIdentifier,
		...(hidden ? { [BYOK_MODEL_HIDDEN_META_KEY]: true } : {}),
	};
}

/**
 * Reads the BYOK model identifier from a model's open `_meta` bag, ignoring unrelated
 * keys and values of the wrong type.
 */
export function readAgentModelByokIdentifier(model: IAgentModelInfo | SessionModelInfo): string | undefined {
	const meta = model._meta;
	if (!meta) {
		return undefined;
	}
	const value = meta[BYOK_MODEL_IDENTIFIER_META_KEY];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the host's hidden marker from a model's open `_meta` bag, ignoring unrelated
 * keys and values of the wrong type. `false` for anything that does not say `true`,
 * including a host old enough not to publish the key at all.
 */
export function readAgentModelByokHidden(model: IAgentModelInfo | SessionModelInfo): boolean {
	const meta = model._meta;
	return meta !== undefined && meta[BYOK_MODEL_HIDDEN_META_KEY] === true;
}
