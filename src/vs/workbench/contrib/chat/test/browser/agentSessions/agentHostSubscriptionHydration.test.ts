/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import type { ActionEnvelope } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import type { SessionState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { SUBSCRIPTION_HYDRATION_TIMEOUT_MS, whenSubscriptionHydratedWithin } from '../../../browser/agentSessions/agentHost/agentHostSubscriptionHydration.js';
import { TURN_ACKNOWLEDGEMENT_TIMEOUT_MS } from '../../../browser/agentSessions/agentHost/agentHostTurnWatchdog.js';

suite('agentHostSubscriptionHydration', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A subscription that starts un-hydrated, exactly as one does between the
	 * subscribe going out and the host answering it.
	 */
	function subscription(disposables: Pick<DisposableStore, 'add'>) {
		const onDidChange = disposables.add(new Emitter<SessionState>());
		const onDidError = disposables.add(new Emitter<Error>());
		let value: SessionState | Error | undefined;
		const sub: IAgentSubscription<SessionState> = {
			get value() { return value; },
			get verifiedValue() { return value instanceof Error ? undefined : value; },
			onDidChange: onDidChange.event,
			onDidError: onDidError.event,
			onWillApplyAction: disposables.add(new Emitter<ActionEnvelope>()).event,
			onDidApplyAction: disposables.add(new Emitter<ActionEnvelope>()).event,
		};
		return {
			sub,
			hasListeners: () => onDidChange.hasListeners() || onDidError.hasListeners(),
			snapshot(state: SessionState) { value = state; onDidChange.fire(state); },
			fail(error: Error) { value = error; onDidError.fire(error); },
		};
	}

	const sessionUri = 'agenthost:/session/abc';

	test('a host that never answers the subscribe fails the wait instead of hanging on it', async () => {
		// The regression: with no bound this await never returns, so the
		// invocation's response promise is never settled and the request spins.
		const { sub } = subscription(store);

		await assert.rejects(
			whenSubscriptionHydratedWithin(sub, sessionUri, 5),
			(err: Error) => /timed out/i.test(err.message) && err.message.includes(sessionUri),
		);
	});

	test('the expired wait leaves no listeners behind on the subscription', async () => {
		// The deadline cancels the wait rather than racing it, so the listeners
		// it holds are released even though the subscription never settled.
		const target = subscription(store);

		await assert.rejects(whenSubscriptionHydratedWithin(target.sub, sessionUri, 5));

		assert.strictEqual(target.hasListeners(), false);
	});

	test('a snapshot resolves the wait, and the deadline never enters into it', async () => {
		const target = subscription(store);
		const waited = whenSubscriptionHydratedWithin(target.sub, sessionUri, 10_000);
		target.snapshot({} as SessionState);

		await waited;
		assert.strictEqual(target.hasListeners(), false);
	});

	test('a subscription that fails outright settles the wait — that is not a timeout', async () => {
		// `setError` fires `onDidError` and NOT `onDidChange`; the caller reads
		// the failure off the subscription, so this must not become a timeout.
		const target = subscription(store);
		const waited = whenSubscriptionHydratedWithin(target.sub, sessionUri, 10_000);
		target.fail(new Error('subscribe failed'));

		await waited;
	});

	test('an already-hydrated subscription resolves without arming anything', async () => {
		const target = subscription(store);
		target.snapshot({} as SessionState);

		await whenSubscriptionHydratedWithin(target.sub, sessionUri, 5);
		assert.strictEqual(target.hasListeners(), false);
	});

	test('the deadline bounds the subscribe round-trip only, and stays clear of the turn watchdog', () => {
		assert.deepStrictEqual({
			generousForOneRoundTrip: SUBSCRIPTION_HYDRATION_TIMEOUT_MS >= 10_000,
			belowAcknowledgementWatchdog: SUBSCRIPTION_HYDRATION_TIMEOUT_MS < TURN_ACKNOWLEDGEMENT_TIMEOUT_MS,
		}, {
			generousForOneRoundTrip: true,
			belowAcknowledgementWatchdog: true,
		});
	});
});
