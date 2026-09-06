/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderChatInput } from '../../../../../workbench/test/browser/componentFixtures/chat/renderChatInput.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from '../../../../../workbench/test/browser/componentFixtures/fixtureUtils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { adaptSessionModelPickerDelegate } from '../../browser/sessionModelPickerPresentation.js';

// Loaded here (rather than in the workbench-layer fixture) so the
// `.interactive-input-part` padding (32px each side) that the `isSessionsWindow`
// layout path accounts for is available without a layering violation.
import '../../browser/media/chatView.css';
import '../../../../browser/media/style.css';

const composerModels: ILanguageModelChatMetadataAndIdentifier[] = ['openai', 'anthropic'].map(vendor => ({
	identifier: `${vendor}/fixture-model`,
	metadata: {
		extension: new ExtensionIdentifier('fixture.extension'),
		id: 'fixture-model',
		name: `${vendor} model`,
		vendor,
		family: vendor,
		version: '1',
		maxInputTokens: 128000,
		maxOutputTokens: 4096,
		capabilities: { toolCalling: true, agentMode: true },
		isDefaultForLocation: { [ChatAgentLocation.Chat]: vendor === 'openai' },
	},
}));

/**
 * Wraps the fixture context so the chat input renders inside the sessions window
 * DOM ancestry the sessions CSS expects:
 * `.agent-sessions-workbench > .part.sessionspart > .interactive-session`.
 * This is what scopes the `.interactive-input-part` 32px horizontal padding that
 * the `isSessionsWindow` layout path accounts for. Returns a derived context whose
 * `container` is the `.part.sessionspart` element the input should render into.
 */
function sessionsWindowContext(context: ComponentFixtureContext): ComponentFixtureContext {
	context.container.classList.add('agent-sessions-workbench');
	const sessionsPart = document.createElement('div');
	sessionsPart.classList.add('part', 'sessionspart');
	context.container.appendChild(sessionsPart);
	return { ...context, container: sessionsPart };
}

export default defineThemedFixtureGroup({ path: 'sessions/chat/input/' }, {
	ComposerModels: defineComponentFixture({
		render: context => renderChatInput(sessionsWindowContext(context), {
			isSessionsWindow: true,
			width: 950,
			models: composerModels,
			modelPickerDelegateAdapter: adaptSessionModelPickerDelegate,
			voiceControl: 'dictationIdle',
		})
	}),
	ComposerModelsNarrow: defineComponentFixture({
		render: context => renderChatInput(sessionsWindowContext(context), {
			isSessionsWindow: true,
			width: 330,
			models: composerModels,
			modelPickerDelegateAdapter: adaptSessionModelPickerDelegate,
			voiceControl: 'dictationIdle',
		})
	}),
	SessionsWindow: defineComponentFixture({
		render: context => renderChatInput(sessionsWindowContext(context), {
			isSessionsWindow: true,
			value: 'word word word word word word word word word word word word word word word word word word word word word word word word',
		})
	}),
	// Partial multi-line selection so the reverse-rounded selection corners are
	// rendered. These cut-out pieces use `.monaco-editor-background`, which must
	// remain opaque so the selection corners render correctly.
	SessionsWindowSelection: defineComponentFixture({
		render: context => renderChatInput(sessionsWindowContext(context), {
			isSessionsWindow: true,
			value: 'asdasd asdasd asdasd\nasd\nasdasd asdasd asdasd asdasd',
			selection: { startLineNumber: 1, startColumn: 3, endLineNumber: 3, endColumn: 8 },
		})
	}),
});
