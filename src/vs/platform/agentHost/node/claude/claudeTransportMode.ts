/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
/**
 * Resolved Claude host transport. `proxy` routes through Copilot CAPI;
 * `native` uses an official first-party Claude login verified by the SDK.
 */
export type ClaudeTransportMode = 'proxy' | 'native';

export interface IClaudeTransportModeInputs {
	readonly allowSignedOutWhenUsable: boolean;
	readonly hasGitHubToken: boolean;
	/** A live SDK account probe confirmed a first-party Claude login. */
	readonly hasExistingSetup: boolean;
}

/**
 * Which transport should the Claude provider fall back to right now? Pure
 * decision; precedence, highest first:
 *
 *  1. Feature flag off means today's default behavior (always proxy).
 *  2. Signed in to GitHub prefers Copilot (proxy).
 *  3. Signed out but with the user's own Claude credentials uses native (no GitHub).
 *  4. Nothing usable still falls back to proxy — the safe end, since attempting
 *     native with no credential would fail inside the SDK rather than at a
 *     surface that can explain itself.
 *
 * This is only the *fallback* for a session whose model names no provider. A
 * provider-qualified model routes on its own provider
 * (`resolveClaudeSessionTransport`), so getting this decision right is what lets
 * a signed-out user with their own credentials start working without being
 * forced to sign in.
 *
 * The result is **not** an input to the Agents window's sign-in gate, and
 * resolving to `proxy` does not by itself make the session type "require GitHub".
 * `getProtectedResources()` marks the Copilot resource `required: false`
 * unconditionally, so nothing decided here can raise a sign-in wall. What
 * separates `None` from `Unusable` downstream is the *model count*, published
 * from the same `accountInfo()` answer that feeds `hasExistingSetup` here — so
 * the two cannot disagree about one user. The proxy fallback of case 4 only
 * bites at use time, when a model-less session materializes with no proxy handle
 * and `_ensureAuthenticated` raises `AHP_AUTH_REQUIRED`.
 *
 * There is deliberately no host-global setting to *prefer* a transport. Since
 * the picker offers both providers' models side by side, transport is downstream
 * of the model the user picked; a flag would keep disagreeing with what the
 * picker shows (it could not stop a Copilot-routed model from being offered or
 * chosen, because neither model enumeration nor the advertised protected
 * resources would consult it). Expressing a preference is a *model*-selection
 * concern — a default/sticky model — not a transport one.
 */
export function resolveClaudeTransportMode(inputs: IClaudeTransportModeInputs): ClaudeTransportMode {
	const { allowSignedOutWhenUsable, hasGitHubToken, hasExistingSetup } = inputs;
	if (!allowSignedOutWhenUsable || hasGitHubToken) {
		return 'proxy';
	}
	return hasExistingSetup ? 'native' : 'proxy';
}

/**
 * Whether the SDK proved an official first-party Claude login. Fumie routes API
 * keys, gateways, Bedrock, and Vertex through the renderer-owned provider
 * catalog instead, so none of those may make the native subscription catalog
 * appear. `apiProvider: 'firstParty'` alone is insufficient: the SDK reports it
 * even for an empty home, where `tokenSource` is the `'none'` sentinel.
 *
 * Claude Code 2.1.220 no longer reports `tokenSource` for a normal claude.ai
 * Keychain login. It reports the subscription identity instead, so both SDK
 * account shapes are accepted here.
 */
export function isClaudeAccountSetUp(account: AccountInfo | undefined): boolean {
	if (account?.apiProvider !== 'firstParty') {
		return false;
	}
	const hasTokenSource = typeof account.tokenSource === 'string'
		&& account.tokenSource.length > 0
		&& account.tokenSource !== 'none';
	const hasSubscriptionIdentity = typeof account.subscriptionType === 'string'
		&& account.subscriptionType.length > 0;
	return hasTokenSource || hasSubscriptionIdentity;
}
