/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { ILanguageModelChatMetadata } from '../../../common/languageModels.js';
import { agentModelIdFromIdentifier, identifierForAgentModelId, resolveIdentifierForAgentModelId } from '../../../browser/agentSessions/agentHost/agentHostModelIdentity.js';

suite('agentHostModelIdentity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function model(vendor: string, id: string, targetChatSessionType: string, isUserSelectable?: boolean, underlyingModelId?: string, extra?: Partial<ILanguageModelChatMetadata>): { identifier: string; metadata: ILanguageModelChatMetadata } {
		return {
			identifier: `${vendor}:${id}`,
			metadata: {
				extension: nullExtensionDescription.identifier,
				id,
				name: id,
				vendor,
				version: '1.0',
				family: id,
				maxInputTokens: 1,
				maxOutputTokens: 1,
				isDefaultForLocation: {},
				targetChatSessionType,
				...(isUserSelectable !== undefined && { isUserSelectable }),
				...(underlyingModelId !== undefined && { underlyingModelId }),
				...extra,
			},
		};
	}

	// The agent vendor and a subscription vendor publish the same model for the
	// same session; only the vendor half of the identifier differs.
	const onAgentVendor = model('agent-host-codex', '@provider=openai:gpt-5.6-sol', 'agent-host-codex');
	const onSubscriptionVendor = model('codex-subscription', '@provider=openai:gpt-5.6-sol', 'agent-host-codex');
	const registered = [onAgentVendor, onSubscriptionVendor];
	const lookup = (identifier: string) => registered.find(m => m.identifier === identifier)?.metadata;

	test('hands the agent its own id whichever vendor published the row', () => {
		assert.deepStrictEqual({
			agentVendor: agentModelIdFromIdentifier(onAgentVendor.identifier, 'agent-host-codex', lookup),
			subscriptionVendor: agentModelIdFromIdentifier(onSubscriptionVendor.identifier, 'agent-host-codex', lookup),
		}, {
			agentVendor: '@provider=openai:gpt-5.6-sol',
			subscriptionVendor: '@provider=openai:gpt-5.6-sol',
		});
	});

	test('an unregistered identifier still loses a matching session-type prefix, and a bare id keeps its colons', () => {
		const none = () => undefined;
		assert.deepStrictEqual({
			prefixed: agentModelIdFromIdentifier('agent-host-codex:@provider=openai:gpt-5.6-sol', 'agent-host-codex', none),
			// Slicing at the first colon would truncate this to `gpt-5.6-sol`.
			bare: agentModelIdFromIdentifier('@provider=openai:gpt-5.6-sol', 'agent-host-codex', none),
			// A vendor that is not this session's is left alone rather than guessed at.
			foreign: agentModelIdFromIdentifier('codex-subscription:@provider=openai:gpt-5.6-sol', 'agent-host-codex', none),
		}, {
			prefixed: '@provider=openai:gpt-5.6-sol',
			bare: '@provider=openai:gpt-5.6-sol',
			foreign: 'codex-subscription:@provider=openai:gpt-5.6-sol',
		});
	});

	test('a model the agent reports resolves back to a row that exists', () => {
		// Only the subscription publishes it now, so naming it under the agent's own
		// vendor would point at a row the picker no longer has.
		assert.deepStrictEqual({
			subscriptionOnly: identifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', [onSubscriptionVendor]),
			both: identifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', registered),
			unknown: identifierForAgentModelId('gpt-4', 'agent-host-codex', registered),
			alreadyQualified: identifierForAgentModelId('agent-host-codex:gpt-4', 'agent-host-codex', registered),
		}, {
			subscriptionOnly: 'codex-subscription:@provider=openai:gpt-5.6-sol',
			both: 'agent-host-codex:@provider=openai:gpt-5.6-sol',
			unknown: 'agent-host-codex:gpt-4',
			alreadyQualified: 'agent-host-codex:gpt-4',
		});
	});

	// The agent's own vendor registers the subscription's models so they stay
	// resolvable, but hides them; the subscription provider the user added is what
	// offers them. Whichever order the two arrive in, the selection must name the
	// row the user can actually see — and must still name the hidden one rather
	// than a fabricated id when the user never added the subscription.
	test('prefers the row a user can pick over the one only registered as fact', () => {
		const hiddenOnAgentVendor = model('agent-host-codex', '@provider=openai:gpt-5.6-sol', 'agent-host-codex', false);
		// A hidden row under a vendor that is not the session's own, so falling back
		// to it is distinguishable from fabricating `${sessionType}:${id}`.
		const hiddenElsewhere = model('codex-remote', '@provider=openai:gpt-5.6-sol', 'agent-host-codex', false);
		assert.deepStrictEqual({
			hiddenFirst: identifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', [hiddenOnAgentVendor, onSubscriptionVendor]),
			hiddenLast: identifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', [onSubscriptionVendor, hiddenOnAgentVendor]),
			hiddenOnly: identifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', [hiddenElsewhere]),
			noneAtAll: identifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', []),
		}, {
			hiddenFirst: 'codex-subscription:@provider=openai:gpt-5.6-sol',
			hiddenLast: 'codex-subscription:@provider=openai:gpt-5.6-sol',
			// Hidden but registered still beats a fabricated id: it resolves.
			hiddenOnly: 'codex-remote:@provider=openai:gpt-5.6-sol',
			noneAtAll: 'agent-host-codex:@provider=openai:gpt-5.6-sol',
		});
	});

	// The catalog fills in one vendor at a time, so a caller resolving at
	// session-open time can be handed the composed fallback purely because it
	// asked early. It has to be able to tell that apart from a real match to
	// know whether asking again could ever produce a different answer.
	test('says whether the identifier came from the catalog or was composed', () => {
		const hiddenElsewhere = model('codex-remote', '@provider=openai:gpt-5.6-sol', 'agent-host-codex', false);
		assert.deepStrictEqual({
			selectable: resolveIdentifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', registered),
			// Hidden but registered resolves, so there is nothing to wait for.
			hiddenOnly: resolveIdentifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', [hiddenElsewhere]),
			emptyCatalog: resolveIdentifierForAgentModelId('@provider=openai:gpt-5.6-sol', 'agent-host-codex', []),
			// For another session, so this catalog will never match it.
			foreignSession: resolveIdentifierForAgentModelId('@provider=anthropic:claude-opus', 'agent-host-codex', registered),
			// The caller's own identifier; re-asking cannot change it.
			alreadyQualified: resolveIdentifierForAgentModelId('agent-host-codex:gpt-4', 'agent-host-codex', []),
		}, {
			selectable: { identifier: 'agent-host-codex:@provider=openai:gpt-5.6-sol', fabricated: false },
			hiddenOnly: { identifier: 'codex-remote:@provider=openai:gpt-5.6-sol', fabricated: false },
			emptyCatalog: { identifier: 'agent-host-codex:@provider=openai:gpt-5.6-sol', fabricated: true },
			foreignSession: { identifier: 'agent-host-codex:@provider=anthropic:claude-opus', fabricated: true },
			alreadyQualified: { identifier: 'agent-host-codex:gpt-4', fabricated: false },
		});
	});

	// A turn replayed from a transcript names its model the way the agent's own
	// runtime did — bare — while the catalog publishes the decorated id the
	// picker row selects. Nothing else in the session can translate between the
	// two, so a bare id has to find its row here or the turn resolves to nothing.
	suite('a raw id the agent reported, against a catalog of decorated ids', () => {

		const decorated = model('agent-host-claude', '@provider=anthropic:claude-opus-4-8', 'agent-host-claude', undefined, 'claude-opus-4-8');

		test('resolves through the underlying id when nothing carries it verbatim', () => {
			assert.deepStrictEqual(
				resolveIdentifierForAgentModelId('claude-opus-4-8', 'agent-host-claude', [decorated]),
				{ identifier: 'agent-host-claude:@provider=anthropic:claude-opus-4-8', fabricated: false },
			);
		});

		test('a row registered under the raw id itself still wins over one that merely runs it', () => {
			// Two providers can serve one underlying model, so the id the caller
			// actually named is the better answer wherever it is registered — and it
			// must win from either side of the catalog.
			const bare = model('claude-subscription', 'claude-opus-4-8', 'agent-host-claude');
			assert.deepStrictEqual({
				exactLast: identifierForAgentModelId('claude-opus-4-8', 'agent-host-claude', [decorated, bare]),
				exactFirst: identifierForAgentModelId('claude-opus-4-8', 'agent-host-claude', [bare, decorated]),
			}, {
				exactLast: 'claude-subscription:claude-opus-4-8',
				exactFirst: 'claude-subscription:claude-opus-4-8',
			});
		});

		test('a selectable underlying match beats a hidden one, and a hidden one still beats fabricating', () => {
			const hidden = model('agent-host-claude', '@provider=copilot:claude-opus-4-8', 'agent-host-claude', false, 'claude-opus-4-8');
			assert.deepStrictEqual({
				bothTiers: identifierForAgentModelId('claude-opus-4-8', 'agent-host-claude', [hidden, decorated]),
				hiddenOnly: identifierForAgentModelId('claude-opus-4-8', 'agent-host-claude', [hidden]),
			}, {
				bothTiers: 'agent-host-claude:@provider=anthropic:claude-opus-4-8',
				hiddenOnly: 'agent-host-claude:@provider=copilot:claude-opus-4-8',
			});
		});

		test('neither id matching is still a fabricated identifier', () => {
			assert.deepStrictEqual(
				resolveIdentifierForAgentModelId('claude-haiku-4-5', 'agent-host-claude', [decorated]),
				{ identifier: 'agent-host-claude:claude-haiku-4-5', fabricated: true },
			);
		});

		test('an underlying id does not reach across into another session\'s catalog', () => {
			assert.deepStrictEqual(
				resolveIdentifierForAgentModelId('claude-opus-4-8', 'agent-host-codex', [decorated]),
				{ identifier: 'agent-host-codex:claude-opus-4-8', fabricated: true },
			);
		});

		// A harness mirrors the workbench BYOK endpoints the user configured for it
		// into its own pool, and those rows carry the *endpoint's* name for the model
		// as their underlying id. That name collides with the harness's own: a Claude
		// pool publishes `claude-fable-5` served by Anthropic and, right next to it, a
		// user's OpenAI-compatible proxy publishing `claude-fable-5` of its own. When
		// a transcript reports the bare id, matching it against the projection credits
		// the user's endpoint — a provider the turn may never have touched — for the
		// run, and the footer then names that endpoint's row.
		suite('a BYOK bridge row cannot claim a run by its underlying id', () => {

			const anthropicFable = model('agent-host-claude', '@provider=anthropic:claude-fable-5%5B1m%5D', 'agent-host-claude', false, 'claude-fable-5[1m]');
			const byokFable = model('agent-host-claude', 'customendpoint/Example/claude-fable-5', 'agent-host-claude', undefined, 'claude-fable-5', { byokModelIdentifier: 'customendpoint/Example/claude-fable-5' });
			const copilotSonnet = model('agent-host-claude', '@provider=copilot:claude-sonnet-5', 'agent-host-claude', undefined, 'claude-sonnet-5');
			const byokSonnet = model('agent-host-claude', 'customendpoint/Example/claude-sonnet-5', 'agent-host-claude', undefined, 'claude-sonnet-5', { byokModelIdentifier: 'customendpoint/Example/claude-sonnet-5' });

			test('a bare native id resolves to its context-window catalog row instead of the BYOK endpoint', () => {
				// The catalog's context-window suffix is not part of the runtime model
				// identity. The native row matches after normalization; the BYOK
				// projection cannot claim the same bare runtime id.
				assert.deepStrictEqual(
					resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [anthropicFable, byokFable]),
					{ identifier: anthropicFable.identifier, fabricated: false },
				);
			});

			test('a BYOK endpoint alone cannot resolve a bare native id', () => {
				for (const candidates of [[byokFable], [copilotSonnet, byokFable]]) {
					assert.deepStrictEqual(
						resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', candidates),
						{ identifier: 'agent-host-claude:claude-fable-5', fabricated: true },
					);
				}
			});

			test('a native row wins over a projection of the same id, from either side of the catalog', () => {
				assert.deepStrictEqual({
					byokFirst: identifierForAgentModelId('claude-sonnet-5', 'agent-host-claude', [byokSonnet, copilotSonnet]),
					byokLast: identifierForAgentModelId('claude-sonnet-5', 'agent-host-claude', [copilotSonnet, byokSonnet]),
				}, {
					byokFirst: 'agent-host-claude:@provider=copilot:claude-sonnet-5',
					byokLast: 'agent-host-claude:@provider=copilot:claude-sonnet-5',
				});
			});

			test('a projection is still resolvable by the id it is published under', () => {
				// A session that really is running the user's endpoint names it that way
				// — that is the id its own turns carry — so the row stays reachable.
				assert.deepStrictEqual(
					resolveIdentifierForAgentModelId('customendpoint/Example/claude-fable-5', 'agent-host-claude', [anthropicFable, byokFable]),
					{ identifier: 'agent-host-claude:customendpoint/Example/claude-fable-5', fabricated: false },
				);
			});
		});
	});

	// The bare id an agent reports can name more than one row: a subscription and
	// a BYOK provider the user configured with the same upstream model both answer
	// to it. Naming the wrong one is not a cosmetic slip — the identifier is what a
	// reopened session restores its model from, so it would move the conversation
	// onto another provider.
	suite('a raw id that several providers answer to', () => {

		// As published: the subscription decorates both ids (the `[1m]` names the
		// window the session is opened with, so the runtime still reports
		// `claude-fable-5`), while the BYOK bridge routes by `vendor/group/id`.
		const subscription = model('claude-subscription', '@provider=anthropic:claude-fable-5%5B1m%5D', 'agent-host-claude', undefined, 'claude-fable-5[1m]');
		const byok = model('agent-host-claude', 'customendpoint/Example/claude-fable-5', 'agent-host-claude', undefined, 'claude-fable-5');

		test('the session\'s own model is the row that ran the turn', () => {
			assert.deepStrictEqual({
				subscriptionFirst: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [subscription, byok], '@provider=anthropic:claude-fable-5%5B1m%5D'),
				byokFirst: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [byok, subscription], '@provider=anthropic:claude-fable-5%5B1m%5D'),
				// The same catalog, for a session that is on the BYOK row.
				onByok: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [subscription, byok], 'customendpoint/Example/claude-fable-5'),
			}, {
				subscriptionFirst: { identifier: 'claude-subscription:@provider=anthropic:claude-fable-5%5B1m%5D', fabricated: false },
				byokFirst: { identifier: 'claude-subscription:@provider=anthropic:claude-fable-5%5B1m%5D', fabricated: false },
				onByok: { identifier: 'agent-host-claude:customendpoint/Example/claude-fable-5', fabricated: false },
			});
		});

		test('without the session\'s model an ambiguous id resolves to nothing, never to a guess', () => {
			// Whichever row the catalog happens to list first, the answer is the
			// composed id — which resolves to no row at all, so the caller falls back
			// to the model the session picked instead of showing another provider's.
			assert.deepStrictEqual({
				subscriptionFirst: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [subscription, byok]),
				byokFirst: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [byok, subscription]),
				// One provider alone is not ambiguous, so it still resolves.
				byokOnly: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [byok]),
				subscriptionOnly: resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [subscription]),
			}, {
				subscriptionFirst: { identifier: 'agent-host-claude:claude-fable-5', fabricated: true },
				byokFirst: { identifier: 'agent-host-claude:claude-fable-5', fabricated: true },
				byokOnly: { identifier: 'agent-host-claude:customendpoint/Example/claude-fable-5', fabricated: false },
				subscriptionOnly: { identifier: 'claude-subscription:@provider=anthropic:claude-fable-5%5B1m%5D', fabricated: false },
			});
		});

		test('the same collision on the Codex side', () => {
			const codexSubscription = model('codex-subscription', '@provider=openai:gpt-5.6-sol', 'agent-host-codex', undefined, 'gpt-5.6-sol');
			const codexByok = model('agent-host-codex', 'customendpoint/Example/gpt-5.6-sol', 'agent-host-codex', undefined, 'gpt-5.6-sol');
			assert.deepStrictEqual({
				ambiguous: resolveIdentifierForAgentModelId('gpt-5.6-sol', 'agent-host-codex', [codexByok, codexSubscription]),
				onSubscription: resolveIdentifierForAgentModelId('gpt-5.6-sol', 'agent-host-codex', [codexByok, codexSubscription], '@provider=openai:gpt-5.6-sol'),
			}, {
				ambiguous: { identifier: 'agent-host-codex:gpt-5.6-sol', fabricated: true },
				onSubscription: { identifier: 'codex-subscription:@provider=openai:gpt-5.6-sol', fabricated: false },
			});
		});

		test('a session model that answers to a different raw id does not hijack the answer', () => {
			// The session is on Haiku while the turn reports Fable: the session's model
			// only breaks ties among rows that actually ran the reported id.
			assert.deepStrictEqual(
				resolveIdentifierForAgentModelId('claude-fable-5', 'agent-host-claude', [byok], '@provider=anthropic:haiku'),
				{ identifier: 'agent-host-claude:customendpoint/Example/claude-fable-5', fabricated: false },
			);
		});
	});

	test('a model for another session is not matched back into this one', () => {
		const otherSession = model('claude-subscription', '@provider=anthropic:claude-opus', 'agent-host-claude');
		assert.deepStrictEqual({
			identifier: identifierForAgentModelId('@provider=anthropic:claude-opus', 'agent-host-codex', [otherSession]),
			rawId: agentModelIdFromIdentifier(otherSession.identifier, 'agent-host-codex', () => otherSession.metadata),
		}, {
			identifier: 'agent-host-codex:@provider=anthropic:claude-opus',
			rawId: 'claude-subscription:@provider=anthropic:claude-opus',
		});
	});
});
