/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import Severity from '../../../../../../base/common/severity.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { Separator, toAction } from '../../../../../../base/common/actions.js';
import { ILanguageModelChatMetadata, ILanguageModelProviderDescriptor } from '../../../common/languageModels.js';
import { buildAddModelsDropdownActions, getModelHoverContent, runStatusEntryAction } from '../../../browser/chatManagement/chatModelsWidget.js';
import { ILanguageModel, IStatusEntry } from '../../../browser/chatManagement/chatModelsViewModel.js';
import { ChatAgentLocation } from '../../../common/constants.js';

function createModel(overrides: Partial<ILanguageModelChatMetadata> = {}): ILanguageModel {
	return {
		metadata: {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4',
			name: 'GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: false
			},
			...overrides
		},
		identifier: 'copilot-gpt-4',
		provider: {
			vendor: { vendor: 'copilot', displayName: 'GitHub Copilot', isDefault: true },
			group: { name: 'GitHub Copilot' }
		},
	} as ILanguageModel;
}

function createVendor(vendor: string, displayName: string, deprecation?: { link?: string }): ILanguageModelProviderDescriptor {
	return { vendor, displayName, isDefault: false, deprecation } as ILanguageModelProviderDescriptor;
}

suite('ChatModelsWidget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs an actionable status from the row without duplicating toolbar clicks', async () => {
		let runCount = 0;
		const entry: IStatusEntry = {
			type: 'status',
			id: 'status.connect',
			message: 'Connect account',
			severity: Severity.Warning,
			action: toAction({ id: 'connect', label: 'Connect', run: () => { runCount++; } }),
		};

		assert.strictEqual(await runStatusEntryAction(entry, document.createElement('div')), true);
		assert.strictEqual(runCount, 1);

		const actionContainer = document.createElement('div');
		actionContainer.classList.add('actions-container');
		const actionButton = actionContainer.appendChild(document.createElement('a'));
		assert.strictEqual(await runStatusEntryAction(entry, actionButton), false);
		assert.strictEqual(runCount, 1);
	});

	suite('getModelHoverContent', () => {

		test('includes cost fields when all four are present', () => {
			const model = createModel({
				inputCost: 4,
				outputCost: 14,
				cacheCost: 1,
				cacheWriteCost: 2
			});

			const markdown = getModelHoverContent(model);
			const value = markdown.value;

			assert.ok(value.includes('Input Cost'));
			assert.ok(value.includes('4 credits per 1M tokens'));
			assert.ok(value.includes('Output Cost'));
			assert.ok(value.includes('14 credits per 1M tokens'));
			assert.ok(value.includes('Cache Read Cost'));
			assert.ok(value.includes('1 credit per 1M tokens'));
			assert.ok(value.includes('Cache Write Cost'));
			assert.ok(value.includes('2 credits per 1M tokens'));
		});

		test('includes only present cost fields', () => {
			const model = createModel({
				inputCost: 3,
				outputCost: 12
				// cacheCost and cacheWriteCost intentionally omitted
			});

			const markdown = getModelHoverContent(model);
			const value = markdown.value;

			assert.ok(value.includes('Input Cost'));
			assert.ok(value.includes('3 credits per 1M tokens'));
			assert.ok(value.includes('Output Cost'));
			assert.ok(value.includes('12 credits per 1M tokens'));
			assert.ok(!value.includes('Cache Read Cost'));
			assert.ok(!value.includes('Cache Write Cost'));
		});

		test('omits cost section when no cost fields are set', () => {
			const model = createModel({});

			const markdown = getModelHoverContent(model);
			const value = markdown.value;

			assert.ok(!value.includes('Input Cost'));
			assert.ok(!value.includes('Output Cost'));
			assert.ok(!value.includes('Cache Read Cost'));
			assert.ok(!value.includes('Cache Write Cost'));
			assert.ok(!value.includes('credits per 1M tokens'));
			assert.ok(!value.includes('credit per 1M tokens'));
		});

		test('includes pricing text when set', () => {
			const model = createModel({ pricing: '1x' });

			const markdown = getModelHoverContent(model);
			const value = markdown.value;

			assert.ok(value.includes('Pricing'));
			assert.ok(value.includes('1x'));
		});

		test('includes both pricing and cost fields when both are present', () => {
			const model = createModel({
				pricing: '1x',
				inputCost: 4,
				outputCost: 14,
				cacheCost: 1
			});

			const markdown = getModelHoverContent(model);
			const value = markdown.value;

			assert.ok(value.includes('Pricing'));
			assert.ok(value.includes('1x'));
			assert.ok(value.includes('Input Cost'));
			assert.ok(value.includes('4 credits per 1M tokens'));
		});

		test('handles zero cost values', () => {
			const model = createModel({
				inputCost: 0,
				outputCost: 0,
				cacheCost: 0
			});

			const markdown = getModelHoverContent(model);
			const value = markdown.value;

			assert.ok(value.includes('Input Cost'));
			assert.ok(value.includes('0 credits per 1M tokens'));
		});
	});

	suite('runStatusEntryAction', () => {

		function statusEntry(overrides: Partial<IStatusEntry>, run: () => void): IStatusEntry {
			return {
				type: 'status',
				id: 'status.provider',
				message: 'Signed in',
				severity: Severity.Info,
				action: toAction({ id: 'signOut', label: 'Sign out', run }),
				...overrides,
			};
		}

		test('a recovery status runs from the row, an explicit-action-only one does not', async () => {
			let recoveryRuns = 0;
			let signOutRuns = 0;
			const recovery = statusEntry({}, () => { recoveryRuns++; });
			const signOut = statusEntry({ explicitActionOnly: true }, () => { signOutRuns++; });

			const ranRecovery = await runStatusEntryAction(recovery, null);
			const ranSignOut = await runStatusEntryAction(signOut, null);

			assert.deepStrictEqual({ ranRecovery, recoveryRuns, ranSignOut, signOutRuns }, {
				ranRecovery: true,
				recoveryRuns: 1,
				ranSignOut: false,
				signOutRuns: 0,
			});
		});
	});

	suite('buildAddModelsDropdownActions', () => {

		test('returns no actions when adding models is not supported', () => {
			const vendors = [createVendor('acme', 'Acme')];
			let vendorRunCount = 0;

			const actions = buildAddModelsDropdownActions(
				vendors,
				false,
				() => { vendorRunCount++; },
			);

			assert.deepStrictEqual({
				ids: actions.map(a => a.id),
				vendorRunCount,
			}, {
				ids: [],
				vendorRunCount: 0,
			});
		});

		test('returns configurable vendor actions sorted with custom vendors pinned at the end', async () => {
			const vendors = [
				createVendor('zebra', 'Zebra'),
				createVendor('acme', 'Acme'),
				createVendor('customoai', 'OpenAI Compatible (Deprecated)'),
				createVendor('customendpoint', 'Custom Endpoint'),
			];
			const ran: string[] = [];

			const actions = buildAddModelsDropdownActions(
				vendors,
				true,
				v => { ran.push(v.vendor); },
			);

			// Execute every non-separator action to capture which path each one runs.
			for (const action of actions) {
				if (!(action instanceof Separator)) {
					await action.run();
				}
			}

			assert.deepStrictEqual({
				shape: actions.map(a => a instanceof Separator ? 'separator' : a.id),
				ran,
			}, {
				shape: ['enable-acme', 'enable-zebra', 'enable-customoai', 'separator', 'enable-customendpoint'],
				ran: ['acme', 'zebra', 'customoai', 'customendpoint'],
			});
		});

		test('prepends GitHub Copilot sign-in when signed out', async () => {
			const ran: string[] = [];
			const actions = buildAddModelsDropdownActions(
				[createVendor('anthropic', 'Anthropic')],
				true,
				vendor => { ran.push(vendor.vendor); },
				() => { ran.push('copilot'); },
			);

			for (const action of actions) {
				if (!(action instanceof Separator)) {
					await action.run();
				}
			}

			assert.deepStrictEqual({
				actions: actions.map(action => action instanceof Separator ? 'separator' : `${action.id}:${action.label}`),
				ran,
			}, {
				actions: ['signIn-github-copilot:GitHub Copilot', 'separator', 'enable-anthropic:Anthropic'],
				ran: ['copilot', 'anthropic'],
			});
		});

		test('offers GitHub Copilot sign-in when BYOK model addition is unavailable', () => {
			const actions = buildAddModelsDropdownActions(
				[createVendor('anthropic', 'Anthropic')],
				false,
				() => assert.fail('vendor action should not run'),
				() => { },
			);

			assert.deepStrictEqual(
				actions.map(action => action instanceof Separator ? 'separator' : `${action.id}:${action.label}`),
				['signIn-github-copilot:GitHub Copilot'],
			);
		});

		test('with no configurable vendors: no actions are returned', async () => {
			const actions = buildAddModelsDropdownActions(
				[],
				true,
				() => assert.fail('vendor run should not be called'),
			);

			assert.deepStrictEqual(
				actions.map(a => a instanceof Separator ? 'separator' : a.id),
				[],
			);
		});

		test('with configurable vendors: vendor actions are separated from the pinned custom endpoint vendor', async () => {
			const vendors = [
				createVendor('acme', 'Acme'),
				createVendor('customendpoint', 'Custom Endpoint'),
			];
			const ran: string[] = [];

			const actions = buildAddModelsDropdownActions(
				vendors,
				true,
				v => { ran.push(v.vendor); },
			);
			for (const action of actions) {
				if (!(action instanceof Separator)) {
					await action.run();
				}
			}

			assert.deepStrictEqual({
				shape: actions.map(a => a instanceof Separator ? 'separator' : a.id),
				ran,
			}, {
				shape: ['enable-acme', 'separator', 'enable-customendpoint'],
				ran: ['acme', 'customendpoint'],
			});
		});

		test('drops a singleton vendor once its entry exists, and keeps offering the rest', () => {
			const vendors = [
				createVendor('acme', 'Acme'),
				{ ...createVendor('claude-subscription', 'Claude Subscription'), singleton: true },
				{ ...createVendor('codex-subscription', 'Codex Subscription'), singleton: true },
			];

			const shape = (vendorsWithGroups: string[]) => buildAddModelsDropdownActions(
				vendors,
				true,
				() => { },
				undefined,
				new Set(vendorsWithGroups),
			).map(action => action instanceof Separator ? 'separator' : action.id);

			assert.deepStrictEqual({
				none: shape([]),
				claudeAdded: shape(['claude-subscription']),
				// A non-singleton vendor stays addable however many entries it has.
				acmeAdded: shape(['acme']),
			}, {
				none: ['enable-acme', 'enable-claude-subscription', 'enable-codex-subscription'],
				claudeAdded: ['enable-acme', 'enable-codex-subscription'],
				acmeAdded: ['enable-acme', 'enable-claude-subscription', 'enable-codex-subscription'],
			});
		});

		test('sinks deprecated providers to the end of the sorted list', () => {
			const vendors = [
				createVendor('zebra', 'Zebra'),
				createVendor('ollama', 'Ollama (Deprecated)', { link: 'vscode:extension/Ollama.ollama' }),
				createVendor('acme', 'Acme'),
				createVendor('customoai', 'OpenAI Compatible (Deprecated)'),
				createVendor('customendpoint', 'Custom Endpoint'),
			];

			const actions = buildAddModelsDropdownActions(vendors, true, () => { });

			assert.deepStrictEqual(
				actions.map(a => a instanceof Separator ? 'separator' : a.id),
				['enable-acme', 'enable-zebra', 'enable-ollama', 'enable-customoai', 'separator', 'enable-customendpoint'],
			);
		});
	});
});
