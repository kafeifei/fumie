/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';

/**
 * How long the client waits for a just-created session's subscription to
 * deliver its first snapshot before it gives up and fails the request.
 *
 * This bounds *hydration*, never the turn — nothing has been dispatched yet at
 * the point this is awaited. An un-hydrated subscription that is never bounded
 * strands the whole invocation: the response promise is only settled by the
 * turn machinery further down, which never gets to run.
 *
 * 30s rather than the 90s of `TURN_ACKNOWLEDGEMENT_TIMEOUT_MS` because the two
 * wait on very different things. That watchdog covers a cold host — session
 * creation, SDK startup, MCP server launch. By the time hydration is awaited
 * `createSession` has already returned, so all of that is behind us and what
 * remains is one subscribe round-trip and the snapshot it answers with,
 * normally milliseconds. 30s leaves a busy host three orders of magnitude of
 * headroom while still failing fast, and staying below the acknowledgement
 * watchdog keeps the two from racing over the same hang, so the message the
 * user gets names the stage that actually stalled.
 */
export const SUBSCRIPTION_HYDRATION_TIMEOUT_MS = 30_000;

/**
 * Resolves once a subscription has received its first snapshot (its
 * `value` is no longer `undefined`) — i.e. it has hydrated with state or
 * an error. Resolves immediately if already hydrated or if cancellation
 * is requested.
 */
export function whenSubscriptionHydrated<T>(sub: IAgentSubscription<T>, token: CancellationToken): Promise<void> {
	if (sub.value !== undefined || token.isCancellationRequested) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		const store = new DisposableStore();
		const settle = () => { store.dispose(); resolve(); };
		store.add(sub.onDidChange(() => { if (sub.value !== undefined) { settle(); } }));
		const onDidError = sub.onDidError;
		if (onDidError) {
			store.add(onDidError(settle));
		}
		store.add(token.onCancellationRequested(settle));
		if (sub.value !== undefined) { settle(); }
	});
}

/**
 * {@link whenSubscriptionHydrated} with a deadline. Rejects when the
 * subscription is still carrying no value after `timeoutMs` — a host that
 * neither answered the subscribe nor failed it, which would otherwise be an
 * unbounded wait.
 *
 * The deadline cancels the underlying wait rather than racing it, so the
 * listeners it holds on the subscription are always released.
 *
 * A subscription that hydrates into an `Error` is *not* a timeout: it settled,
 * and the caller reads the failure off it as it would on any other path.
 */
export async function whenSubscriptionHydratedWithin<T>(sub: IAgentSubscription<T>, sessionUri: string, timeoutMs: number = SUBSCRIPTION_HYDRATION_TIMEOUT_MS): Promise<void> {
	if (sub.value !== undefined) {
		return;
	}
	const source = new CancellationTokenSource();
	let expired = false;
	const timer = disposableTimeout(() => { expired = true; source.cancel(); }, timeoutMs);
	try {
		await whenSubscriptionHydrated(sub, source.token);
	} finally {
		timer.dispose();
		source.dispose();
	}
	if (expired && sub.value === undefined) {
		throw new Error(subscriptionHydrationTimeoutMessage(sessionUri, timeoutMs));
	}
}

/** The failure surfaced for a subscription the host never hydrated. */
export function subscriptionHydrationTimeoutMessage(sessionUri: string, timeoutMs: number): string {
	return localize(
		'agentHost.subscriptionHydrationTimeout',
		"Timed out after {0}s waiting for the agent to send the state of session {1}. Send the message again to retry.",
		Math.round(timeoutMs / 1000),
		sessionUri,
	);
}
