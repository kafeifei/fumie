/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../../../base/common/event.js';
import { constObservable } from '../../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IMenuService, MenuItemAction } from '../../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../../../platform/instantiation/common/serviceCollection.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatInputCanSubmit, ChatInputSubmitMenu, ChatInputSupportsBackground, createChatInputExecuteToolbar, IChatInputSubmitContext } from '../../../../browser/widget/input/chatInputExecuteToolbar.js';

class TestCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand = Event.None;
	readonly onDidExecuteCommand = Event.None;

	constructor(private readonly _instantiationService: IInstantiationService) { }

	async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
		const command = CommandsRegistry.getCommand(id);
		assert.ok(command, `Expected registered command ${id}`);
		return await Promise.resolve(this._instantiationService.invokeFunction(command.handler, ...args)) as T;
	}
}

suite('Chat Input Execute Toolbar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('refreshes submit enablement and forwards normal/background choices', async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const rootContextKeyService = store.add(new ContextKeyService(instantiationService.get(IConfigurationService)));
		instantiationService.stub(IContextKeyService, rootContextKeyService);
		const commandService = new TestCommandService(instantiationService);
		instantiationService.stub(ICommandService, commandService);
		instantiationService.stub(IMenuService, store.add(instantiationService.createInstance(MenuService)));

		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const contextKeyService = store.add(instantiationService.get(IContextKeyService).createScoped(container));
		const scopedInstantiationService = store.add(instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));
		const canSubmit = ChatInputCanSubmit.bindTo(contextKeyService);
		ChatInputSupportsBackground.bindTo(contextKeyService).set(true);
		const submissions: boolean[] = [];
		const context: IChatInputSubmitContext = {
			submitInput: async background => {
				submissions.push(background);
				return true;
			},
		};
		const toolbar = store.add(createChatInputExecuteToolbar(scopedInstantiationService, container, ChatInputSubmitMenu, {
			isActive: constObservable(false),
			isDictationActive: constObservable(false),
			isVoiceActive: constObservable(false),
		}));
		toolbar.context = context;

		const disabledAction = toolbar.getItemAction(0);
		assert.ok(disabledAction instanceof MenuItemAction, `Unexpected toolbar action ${disabledAction?.constructor.name}:${disabledAction?.id}`);
		assert.strictEqual(disabledAction.enabled, false);
		assert.strictEqual(container.querySelector('.chat-submit-button .action-label')?.classList.contains('disabled'), true);

		canSubmit.set(true);
		toolbar.refresh();
		const enabledAction = toolbar.getItemAction(0);
		assert.ok(enabledAction instanceof MenuItemAction);
		assert.strictEqual(enabledAction.enabled, true);
		assert.strictEqual(container.querySelector('.chat-submit-button .action-label')?.classList.contains('disabled'), false);
		assert.ok(enabledAction.alt);

		await toolbar.actionRunner.run(enabledAction, context);
		await toolbar.actionRunner.run(enabledAction.alt, context);
		assert.deepStrictEqual(submissions, [false, true]);
	});
});
