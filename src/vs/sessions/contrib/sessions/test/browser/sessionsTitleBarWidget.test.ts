/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventType } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { AgentSessionApprovalModel } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionApprovalModel.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IChat, ISession } from '../../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { BlockedSessionReason, BlockedSessions, IBlockedSession } from '../../../blockedSessions/browser/blockedSessions.js';
import { BlockedSessionsCIFixModel } from '../../browser/blockedSessionsCIFixModel.js';
import { BlockedSessionsIndicatorModel } from '../../browser/blockedSessionsIndicatorModel.js';
import { SessionActionFeedback } from '../../browser/sessionActionFeedback.js';
import { getTitleBarNormalRenderState, SessionsTitleBarWidget } from '../../browser/sessionsTitleBarWidget.js';

suite('Sessions - SessionsTitleBarWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	class TestCommandService extends mock<ICommandService>() {
		readonly calls: string[] = [];
		override async executeCommand(commandId: string): Promise<undefined> {
			this.calls.push(commandId);
			return undefined;
		}
	}

	function createActiveSession(title: string): IActiveSession {
		return new class extends mock<IActiveSession>() {
			override readonly title: IObservable<string> = constObservable(title);
			override readonly isQuickChat: IObservable<boolean> = constObservable(false);
		}();
	}

	function renderWidget(options: {
		activeSession?: IActiveSession;
		blocked?: readonly IBlockedSession[];
		approvedCount?: number;
		commandService?: TestCommandService;
	}): { host: HTMLElement; commandService: TestCommandService } {
		const store = disposables.add(new DisposableStore());
		const commandService = options.commandService ?? new TestCommandService();
		const instantiationService = workbenchInstantiationService(undefined, store);

		instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
			override readonly activeSession: IObservable<IActiveSession | undefined> = constObservable(options.activeSession);
			override readonly visibleSessions: IObservable<readonly (IActiveSession | undefined)[]> = constObservable<readonly (IActiveSession | undefined)[]>([]);
		}());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = Event.None;
		}());
		instantiationService.stub(ICommandService, commandService);
		instantiationService.stub(IProductService, new class extends mock<IProductService>() {
			override readonly quality = 'insider';
		}());

		const sessionActionFeedback = new class extends mock<SessionActionFeedback>() {
			override readonly approvedCount: IObservable<number> = constObservable(options.approvedCount ?? 0);
			override notifyApproved(): void { }
		}();
		const blocked = options.blocked ?? [];
		const blockedSessionsModel = new class extends mock<BlockedSessions>() {
			override readonly blockedSessions: IObservable<readonly ISession[]> = constObservable(blocked.map(entry => entry.session));
			override readonly blockedSessionsWithReasons: IObservable<readonly IBlockedSession[]> = constObservable(blocked);
		}();
		const ciFixModel = new class extends mock<BlockedSessionsCIFixModel>() {
			override readonly hiddenSessions: IObservable<ReadonlySet<string>> = constObservable<ReadonlySet<string>>(new Set());
		}();
		const approvalModel = new class extends mock<AgentSessionApprovalModel>() {
			override getApproval(): IObservable<undefined> {
				return constObservable(undefined);
			}
		}();
		const blockedIndicator = store.add(instantiationService.createInstance(
			BlockedSessionsIndicatorModel,
			approvalModel,
			blockedSessionsModel,
			ciFixModel,
		));
		const action = new class extends mock<SubmenuItemAction>() {
			override readonly id = 'workbench.agentSessions.titlebar';
			override readonly label = 'Agent Sessions';
			override readonly tooltip = '';
			override readonly enabled = true;
			override async run() { }
		}();

		const host = mainWindow.document.createElement('div');
		host.className = 'action-item';
		const widget = store.add(instantiationService.createInstance(
			SessionsTitleBarWidget,
			action,
			undefined,
			sessionActionFeedback,
			blockedIndicator,
		));
		widget.render(host);
		return { host, commandService };
	}

	test('idle title is display text, not a session-picker button', () => {
		const { host, commandService } = renderWidget({
			activeSession: createActiveSession('Fix authentication redirect loop'),
		});

		assert.strictEqual(host.getAttribute('role'), null);
		assert.strictEqual(host.hasAttribute('tabIndex'), false);
		assert.ok(!host.classList.contains('agent-sessions-titlebar-interactive'));
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-title')?.textContent, 'Fix authentication redirect loop');
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-icon'), null);
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-folder'), null);

		host.dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true }));
		assert.deepStrictEqual(commandService.calls, []);
	});

	test('blocked state remains a button so the requires-input list can open', () => {
		const chat = new class extends mock<IChat>() {
			override readonly resource = URI.parse('session-chat:/blocked/0');
		}();
		const session = new class extends mock<ISession>() {
			override readonly sessionId = 'blocked-0';
			override readonly chats: IObservable<readonly IChat[]> = constObservable([chat]);
		}();
		const { host } = renderWidget({
			activeSession: createActiveSession('Fix authentication redirect loop'),
			blocked: [{ session, reason: BlockedSessionReason.NeedsInput, occurrenceId: 'needs-input:0' }],
		});

		assert.strictEqual(host.getAttribute('role'), 'button');
		assert.ok(host.classList.contains('agent-sessions-titlebar-interactive'));
		assert.ok(host.classList.contains('agent-sessions-titlebar-requires-input'));
	});

	test('cache key is the session title only', () => {
		assert.strictEqual(getTitleBarNormalRenderState('Fix the layout'), 'normal|Fix the layout');
	});
});
