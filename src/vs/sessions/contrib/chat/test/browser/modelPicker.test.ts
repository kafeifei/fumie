/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { needsExplicitModelPlaceholder, shouldShowSessionModelPicker, updateExplicitModelPlaceholder } from '../../browser/modelPicker.js';
import { createModelSelectionState, EMPTY_MODEL_SELECTION_STATE, hasSelectableModel, normalizeModelPickerOptions } from '../../browser/sessionModelPickerState.js';

const aModel = { identifier: 'copilot-gpt-4o', metadata: {} } as ILanguageModelChatMetadataAndIdentifier;

suite('ModelPicker selectability', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns true when models are available', () => {
		assert.strictEqual(hasSelectableModel([aModel], normalizeModelPickerOptions({
			useGroupedModelPicker: true,
			showFeatured: true,
			showUnavailableFeatured: false,
			showManageModelsAction: false,
			showAutoModel: false,
		})), true);
	});

	test('returns false when empty and Auto is unavailable', () => {
		assert.strictEqual(hasSelectableModel([], normalizeModelPickerOptions({
			useGroupedModelPicker: true,
			showFeatured: true,
			showUnavailableFeatured: false,
			showManageModelsAction: false,
			showAutoModel: false,
		})), false);
	});

	test('returns true when empty and Auto support is omitted', () => {
		assert.strictEqual(hasSelectableModel([], normalizeModelPickerOptions({
			useGroupedModelPicker: true,
			showFeatured: true,
			showUnavailableFeatured: false,
			showManageModelsAction: false,
		})), true);
	});

	test('stays hidden on a session-less composer that Chat reports as needing setup', () => {
		const landing = EMPTY_MODEL_SELECTION_STATE;
		const session = createModelSelectionState([], normalizeModelPickerOptions(undefined), undefined, undefined);

		assert.deepStrictEqual({
			landingSetupRequired: shouldShowSessionModelPicker({
				poolResolved: landing.poolResolved,
				modelCount: landing.models.length,
				restrictedMode: false,
				setupRequired: true,
				showAutoModel: landing.options.showAutoModel,
			}),
			landingRestricted: shouldShowSessionModelPicker({
				poolResolved: landing.poolResolved,
				modelCount: landing.models.length,
				restrictedMode: true,
				setupRequired: false,
				showAutoModel: landing.options.showAutoModel,
			}),
			sessionSetupRequired: shouldShowSessionModelPicker({
				poolResolved: session.poolResolved,
				modelCount: session.models.length,
				restrictedMode: false,
				setupRequired: true,
				showAutoModel: session.options.showAutoModel,
			}),
			sessionWithModels: shouldShowSessionModelPicker({
				poolResolved: true,
				modelCount: 1,
				restrictedMode: false,
				setupRequired: false,
				showAutoModel: true,
			}),
			sessionWithoutAuto: shouldShowSessionModelPicker({
				poolResolved: true,
				modelCount: 0,
				restrictedMode: false,
				setupRequired: false,
				showAutoModel: false,
			}),
		}, {
			landingSetupRequired: false,
			landingRestricted: true,
			sessionSetupRequired: true,
			sessionWithModels: true,
			sessionWithoutAuto: true,
		});
	});

	test('uses a neutral placeholder only while an explicit model is unresolved', () => {
		assert.deepStrictEqual({
			explicitModelUnresolved: needsExplicitModelPlaceholder(undefined, [aModel], false),
			autoSupported: needsExplicitModelPlaceholder(undefined, [aModel], true),
			modelSelected: needsExplicitModelPlaceholder(aModel, [aModel], false),
			noModels: needsExplicitModelPlaceholder(undefined, [], false),
		}, {
			explicitModelUnresolved: true,
			autoSupported: false,
			modelSelected: false,
			noModels: false,
		});
	});

	test('replaces the shared Auto label and accessibility value in the Sessions chrome', () => {
		const container = document.createElement('div');
		const split = container.appendChild(document.createElement('div'));
		split.className = 'model-picker-split';
		const name = split.appendChild(document.createElement('a'));
		name.className = 'model-picker-name';
		const label = name.appendChild(document.createElement('span'));
		label.className = 'chat-input-picker-label';
		label.textContent = 'Auto';

		const updated = updateExplicitModelPlaceholder(split, undefined, [aModel], false);

		assert.deepStrictEqual({
			updated,
			label: label.textContent,
			nameAriaLabel: name.getAttribute('aria-label'),
			groupAriaLabel: split.getAttribute('aria-label'),
		}, {
			updated: true,
			label: 'Models',
			nameAriaLabel: 'Models, select a model',
			groupAriaLabel: 'Models, select a model',
		});
	});
});
