/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import Severity from '../../../../../../base/common/severity.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IAgentHostModelProviderPresentation, IAgentHostModelProviderPresentationContext } from '../../../../../services/agentHost/browser/agentHostModelProviderPresentation.js';
import { ILanguageModelChatMetadata, ILanguageModelChatProvider } from '../../../common/languageModels.js';
import { AgentHostLanguageModelProvider } from '../../../browser/agentSessions/agentHost/agentHostLanguageModelProvider.js';

suite('AgentHostLanguageModelProvider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function makeModel(id: string, meta?: Record<string, unknown>): SessionModelInfo {
		return { id, provider: 'copilotcli', name: id === 'auto' ? 'Auto' : id, ...(meta && { _meta: meta }) };
	}

	function createProvider(): AgentHostLanguageModelProvider {
		return store.add(new AgentHostLanguageModelProvider('agent-host-copilotcli', 'copilotcli'));
	}

	test('reports the same model availability status for every Agent Host vendor', async () => {
		const results = [];
		for (const vendor of ['codex', 'claude']) {
			const provider = store.add(new AgentHostLanguageModelProvider(`agent-host-${vendor}`, vendor));
			const languageModelProvider: ILanguageModelChatProvider = provider;
			const options = { silent: false };
			const loading = await languageModelProvider.provideLanguageModelChatStatus?.(options, CancellationToken.None);
			provider.updateModels([]);
			const empty = await languageModelProvider.provideLanguageModelChatStatus?.(options, CancellationToken.None);
			provider.updateModels([{ id: 'model', provider: vendor, name: 'Model' }]);
			const ready = await languageModelProvider.provideLanguageModelChatStatus?.(options, CancellationToken.None);
			results.push({ vendor, loading, empty, ready });
		}

		assert.deepStrictEqual(results, [
			{
				vendor: 'codex',
				loading: { message: 'Loading models…', severity: Severity.Info },
				empty: { message: 'No models available', severity: Severity.Warning },
				ready: undefined,
			},
			{
				vendor: 'claude',
				loading: { message: 'Loading models…', severity: Severity.Info },
				empty: { message: 'No models available', severity: Severity.Warning },
				ready: undefined,
			},
		]);
	});

	// An agent that owns its own model choice (the ACP connector) publishes a
	// single placeholder row. It has no context window, no pricing and no
	// config schema — the picker must still offer it and drop the empty state,
	// otherwise the harness is unusable even though the agent is ready.
	test('surfaces an agent-managed placeholder catalog as a selectable model', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-acp', 'agent-host-acp'));
		const options = { silent: false };

		provider.updateModels([{ id: 'agent-managed', provider: 'acp', name: 'Agent default', supportsVision: false }]);

		assert.strictEqual(await provider.provideLanguageModelChatStatus(options, CancellationToken.None), undefined);
		const models = await provider.provideLanguageModelChatInfo(options, CancellationToken.None);
		assert.deepStrictEqual(models.map(model => [model.identifier, model.metadata.name, model.metadata.targetChatSessionType, model.metadata.isUserSelectable]), [
			['agent-host-acp:agent-managed', 'Agent default', 'agent-host-acp', true],
		]);
	});

	// A subscription's rows reach the picker through the provider the user added
	// for it, so the agent's own vendor must not offer them a second time — but it
	// must still publish them, or nothing can resolve the model a session is
	// running back to a context window.
	test('publishes an unselectable model but does not count it as an available one', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-claude', 'claude'));
		const options = { silent: false };

		provider.updateModels([{ id: '@provider=anthropic:claude-opus', provider: 'claude', name: 'Claude Opus', isUserSelectable: false }]);
		const subscriptionOnly = await provider.provideLanguageModelChatStatus(options, CancellationToken.None);
		const models = await provider.provideLanguageModelChatInfo(options, CancellationToken.None);

		provider.updateModels([
			{ id: '@provider=anthropic:claude-opus', provider: 'claude', name: 'Claude Opus', isUserSelectable: false },
			{ id: '@provider=copilot:claude-opus', provider: 'claude', name: 'Claude Opus' },
		]);
		const withGateway = await provider.provideLanguageModelChatStatus(options, CancellationToken.None);

		assert.deepStrictEqual(models.map(model => [model.identifier, model.metadata.isUserSelectable]), [
			['claude:@provider=anthropic:claude-opus', false],
		]);
		// Nothing left to pick under this vendor reads as no models available, exactly
		// as it did when the row was dropped instead of hidden.
		assert.deepStrictEqual(subscriptionOnly, { message: 'No models available', severity: Severity.Warning });
		assert.strictEqual(withGateway, undefined);
	});

	test('keeps projected models selectable without exposing a standalone empty Provider', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-projection', 'projection', 'projected'));
		const options = { silent: false };

		assert.strictEqual(await provider.provideLanguageModelChatStatus(options, CancellationToken.None), undefined);
		provider.updateModels([]);
		assert.strictEqual(await provider.provideLanguageModelChatStatus(options, CancellationToken.None), undefined);

		provider.updateModels([{ id: 'shared/model', provider: 'projection', name: 'Shared model' }]);
		const models = await provider.provideLanguageModelChatInfo(options, CancellationToken.None);
		assert.deepStrictEqual(models.map(model => model.identifier), ['projection:shared/model']);
	});

	test('lets a generic presentation recover an owned Provider hidden by BYOK projections', async () => {
		const presentationChanges = store.add(new Emitter<void>());
		const contexts: IAgentHostModelProviderPresentationContext[] = [];
		const presentation: IAgentHostModelProviderPresentation = {
			onDidChange: presentationChanges.event,
			provideStatus: context => {
				contexts.push(context);
				return context.hasNativeModels ? undefined : { message: 'Connect account', severity: Severity.Warning };
			},
		};
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-owned', 'owned', 'owned', presentation));
		let presentationRefreshes = 0;
		store.add(provider.onDidChange(() => presentationRefreshes++));

		provider.updateModels([makeModel('shared/model', { byokModelIdentifier: 'shared/model' })]);
		assert.deepStrictEqual(await provider.provideLanguageModelChatStatus({}, CancellationToken.None), {
			message: 'Connect account',
			severity: Severity.Warning,
		});
		assert.deepStrictEqual(contexts.at(-1), { hasModelSnapshot: true, hasNativeModels: false });

		presentationRefreshes = 0;
		presentationChanges.fire();
		assert.strictEqual(presentationRefreshes, 1);

		provider.updateModels([makeModel('native-model')]);
		assert.strictEqual(await provider.provideLanguageModelChatStatus({}, CancellationToken.None), undefined);
		assert.deepStrictEqual(contexts.at(-1), { hasModelSnapshot: true, hasNativeModels: true });
	});

	test('renders the auto-mode discount as the Auto model detail (and a tooltip)', async () => {
		const provider = createProvider();
		provider.updateModels([makeModel('auto', { discountPercent: 10 }), makeModel('gpt-5')]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		const auto = infos.find(m => m.metadata.id === 'auto');
		const concrete = infos.find(m => m.metadata.id === 'gpt-5');

		assert.strictEqual(auto?.metadata.detail, '10% discount');
		assert.ok(auto?.metadata.tooltip?.includes('10% discount'), 'Auto tooltip should mention the discount');
		assert.ok(auto?.metadata.tooltip?.includes('Learn More'), 'Auto tooltip should include the Learn More link');

		// Concrete models get neither the discount detail nor the Auto tooltip.
		assert.strictEqual(concrete?.metadata.detail, undefined);
		assert.strictEqual(concrete?.metadata.tooltip, undefined);
	});

	test('shows the Auto tooltip but no detail when there is no positive discount', async () => {
		const provider = createProvider();

		// The realistic cold-open case: the runtime omits billing, so there is no discount to show.
		provider.updateModels([makeModel('auto')]);
		let auto = (await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None)).find(m => m.metadata.id === 'auto');
		assert.strictEqual(auto?.metadata.detail, undefined, 'absent discount → no detail');
		assert.ok(auto?.metadata.tooltip && auto.metadata.tooltip.length > 0, 'Auto still has a tooltip');
		assert.ok(!auto?.metadata.tooltip?.includes('discount'), 'no discount → tooltip omits the discount sentence');

		// Guard: a literal 0 must not render a misleading "0% discount".
		provider.updateModels([makeModel('auto', { discountPercent: 0 })]);
		auto = (await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None)).find(m => m.metadata.id === 'auto');
		assert.strictEqual(auto?.metadata.detail, undefined, 'discountPercent 0 → no detail');
	});

	test('carries picker category, price category, and promo from model metadata', async () => {
		const provider = createProvider();
		provider.updateModels([
			makeModel('claude-sonnet', {
				category: 'powerful',
				priceCategory: 'medium',
				promo: {
					id: 'summer-sale',
					discountPercent: 25,
					endsAt: '2026-08-01T00:00:00Z',
					message: 'Save on Claude Sonnet',
				},
			}),
			// Open-ended, message-only promo: the untyped `_meta` read must keep it
			// rather than drop the promo for the missing `endsAt` / zero discount.
			makeModel('gpt-5', {
				promo: {
					id: 'featured',
					discountPercent: 0,
					message: 'Now available',
				},
			}),
		]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		assert.deepStrictEqual(infos.map(info => ({
			category: info.metadata.category,
			priceCategory: info.metadata.priceCategory,
			promo: info.metadata.promo,
		})), [
			{
				category: 'powerful',
				priceCategory: 'medium',
				promo: {
					id: 'summer-sale',
					discountPercent: 25,
					endsAt: '2026-08-01T00:00:00Z',
					message: 'Save on Claude Sonnet',
				},
			},
			{
				category: undefined,
				priceCategory: undefined,
				promo: { id: 'featured', discountPercent: 0, message: 'Now available' },
			},
		]);
	});

	test('derives the picker group from the model-id prefix, not the harness provider', async () => {
		const provider = createProvider();
		// The agent host reports every model under the harness provider (`copilotcli`);
		// the upstream provider lives in the id prefix. Native models have no prefix.
		provider.updateModels([
			{ id: 'claude-haiku-4.5', provider: 'copilotcli', name: 'Claude Haiku 4.5' },
			{ id: 'openai/gpt-5-nano', provider: 'copilotcli', name: 'GPT-5 nano' },
			{ id: 'huggingface/allenai/Olmo-3-7B-Instruct:cheapest', provider: 'copilotcli', name: 'Olmo 3' },
			{ id: 'acme/model', provider: 'copilotcli', name: 'Acme' },
		]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		const groups = Object.fromEntries(infos.map(m => [m.metadata.id, m.metadata.modelGroup]));

		// The group carries only the vendor id — native (no prefix) → harness `provider`,
		// BYOK-routed → id prefix. The picker resolves the display name from the vendor registry.
		assert.deepStrictEqual(groups, {
			'claude-haiku-4.5': { id: 'copilotcli' },
			'openai/gpt-5-nano': { id: 'openai' },
			'huggingface/allenai/Olmo-3-7B-Instruct:cheapest': { id: 'huggingface' },
			'acme/model': { id: 'acme' },
		});
	});

	// The bare id the agent's runtime reports is the only handle a turn replayed
	// from a transcript has; if the vendor drops it here, nothing downstream can
	// match that turn's model back to the row it was run on.
	test('carries the underlying model id onto the published metadata, and omits it when the agent published none', async () => {
		const provider = createProvider();
		provider.updateModels([
			{ id: '@provider=anthropic:claude-opus-4-8', underlyingModelId: 'claude-opus-4-8', provider: 'claude', name: 'Claude Opus 4.8' },
			{ id: 'claude-haiku-4.5', provider: 'claude', name: 'Claude Haiku 4.5' },
		]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		assert.deepStrictEqual(infos.map(info => ({ id: info.metadata.id, underlyingModelId: info.metadata.underlyingModelId })), [
			{ id: '@provider=anthropic:claude-opus-4-8', underlyingModelId: 'claude-opus-4-8' },
			{ id: 'claude-haiku-4.5', underlyingModelId: undefined },
		]);
	});

	test('omits the model group when the provider is empty', async () => {
		const provider = createProvider();
		provider.updateModels([{ id: 'x', provider: '', name: 'X' }]);

		const info = (await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None))[0];
		assert.strictEqual(info.metadata.modelGroup, undefined);
	});

	test('keeps duplicate Codex model names distinct and provider scoped', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-codex', 'codex'));
		provider.updateModels([
			{ id: '@provider=vscode-proxy:gpt-5.6-sol', provider: 'copilot', name: 'GPT-5.6 Sol' },
			{ id: '@provider=openai:gpt-5.6-sol', provider: 'chatgpt', name: 'GPT-5.6 Sol', _meta: { modelSourceId: 'chatgptSubscription' } },
		]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		assert.deepStrictEqual(infos.map(info => ({
			identifier: info.identifier,
			name: info.metadata.name,
			group: info.metadata.modelGroup,
		})), [
			{ identifier: 'codex:@provider=vscode-proxy:gpt-5.6-sol', name: 'GPT-5.6 Sol', group: { id: 'copilot' } },
			{ identifier: 'codex:@provider=openai:gpt-5.6-sol', name: 'GPT-5.6 Sol', group: { id: 'chatgpt', sourceId: 'chatgptSubscription' } },
		]);
	});

	test('does not infer a trusted source from provider names', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-codex', 'codex'));
		provider.updateModels([{ id: '@provider=openai:gpt-5.6-sol', provider: 'chatgpt', name: 'GPT-5.6 Sol' }]);

		const info = (await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None))[0];
		assert.deepStrictEqual(info.metadata.modelGroup, { id: 'chatgpt' });
	});

	test('projects service tier metadata into the generic performance group', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-codex', 'codex'));
		provider.updateModels([{
			id: 'gpt-5.6-sol',
			provider: 'chatgpt',
			name: 'GPT-5.6 Sol',
			configSchema: {
				type: 'object',
				properties: {
					thinkingLevel: { type: 'string', title: 'Thinking Effort', enum: ['medium'], enumLabels: ['Medium'] },
					serviceTier: {
						type: 'string',
						title: 'Speed',
						description: 'Select response speed',
						enum: ['standard', 'priority'],
						enumLabels: ['Standard', 'Fast'],
						enumDescriptions: ['Default speed and usage', '1.5x speed, increased usage'],
						default: 'standard',
					},
					contextSize: { type: 'number', title: 'Context Size', enum: [65536], enumLabels: ['64K'] },
				},
			},
		}]);

		const info = (await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None))[0];
		assert.deepStrictEqual(info.metadata.configurationSchema, {
			type: 'object',
			required: undefined,
			properties: {
				thinkingLevel: {
					type: 'string', title: 'Thinking Effort', description: undefined, default: undefined,
					enum: ['medium'], enumItemLabels: ['Medium'], enumDescriptions: undefined, readOnly: undefined, group: 'navigation',
				},
				serviceTier: {
					type: 'string', title: 'Speed', description: 'Select response speed', default: 'standard',
					enum: ['standard', 'priority'], enumItemLabels: ['Standard', 'Fast'],
					enumDescriptions: ['Default speed and usage', '1.5x speed, increased usage'], readOnly: undefined, group: 'performance',
				},
				contextSize: {
					type: 'number', title: 'Context Size', description: undefined, default: undefined,
					enum: [65536], enumItemLabels: ['64K'], enumDescriptions: undefined, readOnly: undefined, group: 'tokens',
				},
			},
		});
	});

	test('groups Claude models by transport provider: Copilot-routed vs native Anthropic', async () => {
		const provider = store.add(new AgentHostLanguageModelProvider('agent-host-claude', 'claude'));
		// Per-session provider selection: the agent host's merged catalog keeps each
		// model's `provider` as the routing owner (`claude`) and carries the transport
		// (`copilot` for the Copilot-CAPI proxy, `anthropic` for the user's own Anthropic
		// account) in `_meta.modelGroupId`, qualifying the id the same way. The picker
		// buckets by that group token, so the same model offered by both transports
		// yields two distinct rows in two distinct groups — and, unlike Codex, native
		// Claude carries no `chatgptSubscription` source.
		provider.updateModels([
			{ id: '@provider=copilot:claude-opus-4.6', provider: 'claude', name: 'Claude Opus 4.6', _meta: { modelGroupId: 'copilot' } },
			{ id: '@provider=anthropic:claude-opus-4.6', provider: 'claude', name: 'Claude Opus 4.6', _meta: { modelGroupId: 'anthropic' } },
		]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		assert.deepStrictEqual(infos.map(info => ({
			identifier: info.identifier,
			name: info.metadata.name,
			group: info.metadata.modelGroup,
		})), [
			{ identifier: 'claude:@provider=copilot:claude-opus-4.6', name: 'Claude Opus 4.6', group: { id: 'copilot' } },
			{ identifier: 'claude:@provider=anthropic:claude-opus-4.6', name: 'Claude Opus 4.6', group: { id: 'anthropic' } },
		]);
	});

	test('carries the BYOK model identifier from _meta so the Manage Models toggle can be honoured', async () => {
		const provider = createProvider();
		// A grouped BYOK copy: the node agent host carried the original LM service identifier
		// (`<vendor>/<group>/<id>`) via _meta; the provider surfaces it verbatim.
		provider.updateModels([
			makeModel('openrouter/aion-labs/aion-3.0', { byokModelIdentifier: 'openrouter/OpenRouter 2/aion-labs/aion-3.0' }),
			// A groupless BYOK copy and a native model (no _meta) for contrast.
			makeModel('anthropic/claude-sonnet-4', { byokModelIdentifier: 'anthropic/claude-sonnet-4' }),
			makeModel('claude-haiku-4.5'),
		]);

		const infos = await provider.provideLanguageModelChatInfo(undefined, CancellationToken.None);
		const byName = Object.fromEntries(infos.map(m => [m.metadata.id, m.metadata]));

		// The carried identifier is surfaced on the metadata and returned by the accessor.
		assert.deepStrictEqual({
			grouped: {
				byokModelIdentifier: byName['openrouter/aion-labs/aion-3.0'].byokModelIdentifier,
				manageModelsId: ILanguageModelChatMetadata.getAgentHostByokManageModelsIdentifier(byName['openrouter/aion-labs/aion-3.0']),
			},
			groupless: {
				byokModelIdentifier: byName['anthropic/claude-sonnet-4'].byokModelIdentifier,
				manageModelsId: ILanguageModelChatMetadata.getAgentHostByokManageModelsIdentifier(byName['anthropic/claude-sonnet-4']),
			},
			native: {
				byokModelIdentifier: byName['claude-haiku-4.5'].byokModelIdentifier,
				manageModelsId: ILanguageModelChatMetadata.getAgentHostByokManageModelsIdentifier(byName['claude-haiku-4.5']),
			},
		}, {
			grouped: { byokModelIdentifier: 'openrouter/OpenRouter 2/aion-labs/aion-3.0', manageModelsId: 'openrouter/OpenRouter 2/aion-labs/aion-3.0' },
			groupless: { byokModelIdentifier: 'anthropic/claude-sonnet-4', manageModelsId: 'anthropic/claude-sonnet-4' },
			native: { byokModelIdentifier: undefined, manageModelsId: undefined },
		});
	});
});
