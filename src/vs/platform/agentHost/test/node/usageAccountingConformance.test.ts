/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { readUsageInfoMeta, usageOccupancyTokens, type UsageInfo } from '../../common/state/sessionState.js';
import { acpUsageDelta } from '../../node/acp/acpSessionMapper.js';
import { ClaudeMapperState, mapSDKMessageToAgentSignals } from '../../node/claude/claudeMapSessionEvents.js';
import { mapSessionMessagesToTurns } from '../../node/claude/claudeReplayMapper.js';
import { SubagentRegistry } from '../../node/claude/claudeSubagentRegistry.js';
import { mapTokenUsageUpdated } from '../../node/codex/codexMapAppServerEvents.js';
import { kimiUsage } from '../../node/kimi/kimiAgent.js';
import { piUsage } from '../../node/pi/piAgent.js';
import { replayPiMessagesToTurns } from '../../node/pi/piReplayMapper.js';
import { makeAssistantMessage, makeResultSuccess } from './claudeMapSessionEventsTestUtils.js';

/**
 * The token-accounting contract every provider mapper owes the context-usage
 * gauge, asserted the same way for all of them.
 *
 * The bug this suite exists to stop recurring came back four times in four
 * mappers because the rule lived in one provider's comment: each mapper folded
 * the prompt's three parts into `inputTokens` its own way, and whichever part a
 * mapper forgot vanished from the gauge. The rule and the fold are now
 * `usageOccupancyTokens`'s alone, and a mapper's only job is to put each
 * upstream number in the counter that means the same thing —
 * `UsageInfo.inputTokens`, `UsageInfo.cacheReadTokens`, and
 * `_meta.cacheCreationTokens`, the last of which lives in `_meta` because the
 * generated protocol type has no field for it.
 *
 * Adding a provider means adding one {@link IProviderUsageCase} to
 * {@link PROVIDER_CASES}; the assertions come for free.
 */
suite('usage accounting conformance', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** One call's usage as the model server reports it, in neutral terms. */
	interface IUpstreamUsage {
		/** Prompt tokens the model had to read fresh, cache aside. */
		readonly fresh: number;
		/** Prompt tokens served out of the prompt cache. */
		readonly cacheRead: number;
		/** Prompt tokens newly written into the prompt cache. */
		readonly cacheWrite: number;
		readonly output: number;
	}

	interface IProviderUsageCase {
		readonly name: string;
		/** Runs the provider's real usage-building path over `upstream`. */
		readonly map: (upstream: IUpstreamUsage) => UsageInfo | undefined;
		/**
		 * Set when the upstream protocol has no cache-write counter at all, so
		 * those tokens cannot reach the gauge however faithful the mapper is.
		 * `_meta.cacheCreationTokens` stays unset — absent, not zero — and
		 * occupancy is the two counters the agent does report.
		 */
		readonly cacheWriteUnreported?: boolean;
	}

	const CLAUDE_SESSION = URI.parse('agent-session://conformance/claude');
	const CLAUDE_SESSION_ID = 'sid-conformance';
	const CLAUDE_TURN_ID = 'turn-conformance';
	const logService = new NullLogService();

	function claudeLiveUsage(upstream: IUpstreamUsage, store: Pick<DisposableStore, 'add'>): UsageInfo | undefined {
		const state = new ClaudeMapperState();
		const registry = store.add(new SubagentRegistry());
		const assistant = makeAssistantMessage(CLAUDE_SESSION_ID, []);
		assistant.message.usage = {
			...assistant.message.usage,
			input_tokens: upstream.fresh,
			cache_read_input_tokens: upstream.cacheRead,
			cache_creation_input_tokens: upstream.cacheWrite,
			output_tokens: upstream.output,
		};
		mapSDKMessageToAgentSignals(assistant, CLAUDE_SESSION, CLAUDE_TURN_ID, state, logService, registry);

		const result = makeResultSuccess(CLAUDE_SESSION_ID);
		const signals = mapSDKMessageToAgentSignals(result, CLAUDE_SESSION, CLAUDE_TURN_ID, state, logService, registry);
		for (const signal of signals) {
			if (signal.kind === 'action' && signal.action.type === ActionType.ChatUsage) {
				return signal.action.usage;
			}
		}
		return undefined;
	}

	function claudeReplayUsage(upstream: IUpstreamUsage): UsageInfo | undefined {
		const user: SessionMessage = {
			type: 'user',
			uuid: 'u1',
			session_id: 'sess-conformance',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
		};
		const assistant: SessionMessage = {
			type: 'assistant',
			uuid: 'a1',
			session_id: 'sess-conformance',
			parent_tool_use_id: null,
			parent_agent_id: null,
			// The transcript's raw envelope, which is wider than the SDK's
			// published assistant-message type; the replay mapper narrows it at
			// the seam, so the fixture is written the way a real transcript is.
			message: {
				id: 'msg_a1',
				role: 'assistant',
				model: 'claude-test',
				content: [{ type: 'text', text: 'world' }],
				usage: {
					input_tokens: upstream.fresh,
					cache_read_input_tokens: upstream.cacheRead,
					cache_creation_input_tokens: upstream.cacheWrite,
					output_tokens: upstream.output,
				},
			} as SessionMessage['message'],
		};
		return mapSessionMessagesToTurns([user, assistant], URI.parse('claude:/sess-conformance'), logService)[0]?.usage;
	}

	function piMessage(upstream: IUpstreamUsage) {
		return {
			role: 'assistant',
			content: [{ type: 'text', text: 'done' }],
			stopReason: 'stop',
			usage: { input: upstream.fresh, output: upstream.output, cacheRead: upstream.cacheRead, cacheWrite: upstream.cacheWrite },
			timestamp: 1_000,
		} as const;
	}

	const PROVIDER_CASES: readonly IProviderUsageCase[] = [
		{
			name: 'claude (live)',
			map: upstream => claudeLiveUsage(upstream, disposables),
		},
		{
			name: 'claude (replay)',
			map: claudeReplayUsage,
		},
		{
			name: 'kimi',
			map: upstream => kimiUsage({
				currentTurn: {
					inputOther: upstream.fresh,
					inputCacheRead: upstream.cacheRead,
					inputCacheCreation: upstream.cacheWrite,
					output: upstream.output,
				},
			}),
		},
		{
			name: 'pi (live)',
			map: upstream => piUsage(piMessage(upstream)),
		},
		{
			name: 'pi (replay)',
			map: upstream => replayPiMessagesToTurns([
				{ role: 'user', content: 'hello', timestamp: 900 },
				piMessage(upstream),
			], 'sess-conformance', '/workspace')[0]?.usage,
		},
		{
			name: 'codex',
			// Codex's `inputTokens` is read as inclusive of `cachedInputTokens`
			// (see `codexUsageBreakdown`), so the upstream fixture adds the two
			// the way the app-server is assumed to. `cacheWriteInputTokens` is
			// reported but deliberately not folded yet — hence
			// `cacheWriteUnreported`, which is what "does not reach the gauge"
			// means here too.
			cacheWriteUnreported: true,
			map: upstream => {
				const actions = mapTokenUsageUpdated({
					threadId: 'thr_conformance',
					turnId: CLAUDE_TURN_ID,
					tokenUsage: {
						last: {
							inputTokens: upstream.fresh + upstream.cacheRead,
							cachedInputTokens: upstream.cacheRead,
							cacheWriteInputTokens: upstream.cacheWrite,
							outputTokens: upstream.output,
							reasoningOutputTokens: 0,
							totalTokens: upstream.fresh + upstream.cacheRead + upstream.output,
						},
						total: {
							inputTokens: upstream.fresh + upstream.cacheRead,
							cachedInputTokens: upstream.cacheRead,
							cacheWriteInputTokens: upstream.cacheWrite,
							outputTokens: upstream.output,
							reasoningOutputTokens: 0,
							totalTokens: upstream.fresh + upstream.cacheRead + upstream.output,
						},
						modelContextWindow: 200_000,
					},
				});
				const action = actions[0];
				return action?.type === ActionType.ChatUsage ? action.usage : undefined;
			},
		},
		{
			// ACP's `Usage` has no cache-write counter, so those tokens are
			// simply not knowable from an ACP agent.
			name: 'acp',
			cacheWriteUnreported: true,
			map: upstream => acpUsageDelta(undefined, {
				inputTokens: upstream.fresh,
				outputTokens: upstream.output,
				cachedReadTokens: upstream.cacheRead,
				totalTokens: upstream.fresh + upstream.cacheRead + upstream.output,
			}),
		},
	];

	/** Occupancy the gauge must show for `upstream` under a given provider. */
	function expectedOccupancy(usageCase: IProviderUsageCase, upstream: IUpstreamUsage): number {
		return upstream.fresh + upstream.cacheRead + (usageCase.cacheWriteUnreported ? 0 : upstream.cacheWrite);
	}

	for (const usageCase of PROVIDER_CASES) {
		suite(usageCase.name, () => {

			test('keeps the prompt split across the counters it belongs in, un-summed', () => {
				const upstream: IUpstreamUsage = { fresh: 500, cacheRead: 40_000, cacheWrite: 2_000, output: 300 };
				const usage = usageCase.map(upstream);
				assert.ok(usage, 'the mapper reported no usage at all');

				// The pre-fold bug's signature: every input-side token piled
				// into `inputTokens`. A mapper that transcribes leaves the
				// fresh share strictly smaller than the whole prompt.
				assert.ok(
					(usage.inputTokens ?? 0) < expectedOccupancy(usageCase, upstream),
					`inputTokens ${usage.inputTokens} already carries the cached prefix — the mapper is pre-summing`,
				);
				// The popup's "of which cached" row reads this field alone, so
				// it stays the cache-read share and nothing else.
				assert.strictEqual(usage.cacheReadTokens, upstream.cacheRead);
				assert.strictEqual(usage.outputTokens, upstream.output);
				if (!usageCase.cacheWriteUnreported) {
					assert.strictEqual(readUsageInfoMeta(usage).cacheCreationTokens, upstream.cacheWrite);
				}
			});

			test('occupancy is the sum of the input-side counters', () => {
				const upstream: IUpstreamUsage = { fresh: 500, cacheRead: 40_000, cacheWrite: 2_000, output: 300 };
				assert.strictEqual(
					usageOccupancyTokens(usageCase.map(upstream)),
					expectedOccupancy(usageCase, upstream),
				);
			});

			test('a first turn counts the tokens it wrote to cache', () => {
				// Nothing is read from cache on turn one and the whole prompt is
				// written to it, so a mapper that drops the cache-write count
				// reports a nearly empty context window for a full one.
				const upstream: IUpstreamUsage = { fresh: 800, cacheRead: 0, cacheWrite: 30_000, output: 120 };
				const usage = usageCase.map(upstream);
				assert.ok(usage, 'the mapper reported no usage at all');
				assert.strictEqual(usageOccupancyTokens(usage), expectedOccupancy(usageCase, upstream));
				if (!usageCase.cacheWriteUnreported) {
					assert.strictEqual(readUsageInfoMeta(usage).cacheCreationTokens, 30_000);
					assert.ok(usageOccupancyTokens(usage) > (usage.inputTokens ?? 0), 'the cache write did not reach occupancy');
				}
			});
		});
	}

	test('usageOccupancyTokens sums exactly the three input-side counters', () => {
		assert.strictEqual(usageOccupancyTokens({ inputTokens: 1, cacheReadTokens: 20, outputTokens: 4_000, _meta: { cacheCreationTokens: 300 } }), 321);
		// Absent counters contribute nothing; an agent that reports only some of
		// them still gets an answer rather than NaN.
		assert.strictEqual(usageOccupancyTokens({ outputTokens: 7 }), 0);
		assert.strictEqual(usageOccupancyTokens(undefined), 0);
		// A malformed `_meta` degrades to absent rather than poisoning the sum.
		assert.strictEqual(usageOccupancyTokens({ inputTokens: 5, _meta: { cacheCreationTokens: 'lots' } }), 5);
	});
});
