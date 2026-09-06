/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IReference } from '../../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IAgentResolveSessionConfigParams } from '../../../../../../platform/agentHost/common/agent.js';
import { IAgentHostEnablementService } from '../../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { SessionConfigKey } from '../../../../../../platform/agentHost/common/sessionConfigKeys.js';
import type { ResolveSessionConfigResult } from '../../../../../../platform/agentHost/common/state/protocol/commands.js';
import { SessionLifecycle, type SessionState } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import { type INotification, NotificationType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { type ComponentToState, SessionStatus as ProtocolSessionStatus, StateComponents } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IChatWidget } from '../../../browser/chat.js';
import { AgentHostGenericConfigChips } from '../../../browser/agentSessions/agentHost/agentHostGenericConfigChips.js';
import { IAgentHostNewSessionFolderService } from '../../../browser/agentSessions/agentHost/agentHostNewSessionFolderService.js';
import { IAgentHostSessionWorkingDirectoryResolver } from '../../../browser/agentSessions/agentHost/agentHostSessionWorkingDirectoryResolver.js';
import { IAgentHostUntitledProvisionalSessionService } from '../../../browser/agentSessions/agentHost/agentHostUntitledProvisionalSessionService.js';

function createSubscription<T>(): IAgentSubscription<T> {
	return {
		value: undefined,
		verifiedValue: undefined,
		onDidChange: Event.None,
		onWillApplyAction: Event.None,
		onDidApplyAction: Event.None,
	};
}

function createWorkingDirectoryResolver(isNewSession: boolean): IAgentHostSessionWorkingDirectoryResolver {
	return {
		resolve: () => undefined,
		isNewSession: () => isNewSession,
	} as Partial<IAgentHostSessionWorkingDirectoryResolver> as IAgentHostSessionWorkingDirectoryResolver;
}

suite('AgentHostGenericConfigChips', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('moves its subscription when the provisional generation changes', () => {
		const sessionResource = URI.parse('agent-host-copilot:/untitled-test');
		const firstBackend = URI.parse('copilot:/first-generation');
		const secondBackend = URI.parse('copilot:/second-generation');
		const provisionalChanged = disposables.add(new Emitter<URI>());
		let currentBackend = firstBackend;
		const provisionalService = {
			onDidChange: provisionalChanged.event,
			get: () => currentBackend,
		} as Partial<IAgentHostUntitledProvisionalSessionService> as IAgentHostUntitledProvisionalSessionService;
		const acquired: string[] = [];
		const released: string[] = [];
		const agentHostService = new class extends mock<IAgentHostService>() {
			declare readonly _serviceBrand: undefined;

			override getSubscription<T extends StateComponents>(_kind: T, resource: URI, _owner: string): IReference<IAgentSubscription<ComponentToState[T]>> {
				acquired.push(resource.toString());
				return {
					object: createSubscription<ComponentToState[T]>(),
					dispose: () => released.push(resource.toString()),
				};
			}
		}();
		const widget = {
			viewModel: { sessionResource },
			onDidChangeViewModel: Event.None,
		} as Partial<IChatWidget> as IChatWidget;
		const chips = disposables.add(new AgentHostGenericConfigChips(
			widget,
			disposables.add(new TestInstantiationService()),
			agentHostService,
			provisionalService,
			createWorkingDirectoryResolver(false),
			{} as IWorkspaceContextService,
			{} as IAgentHostNewSessionFolderService,
		));

		currentBackend = secondBackend;
		provisionalChanged.fire(sessionResource);

		assert.deepStrictEqual({
			acquired,
			released,
		}, {
			acquired: [firstBackend.toString(), secondBackend.toString()],
			released: [firstBackend.toString()],
		});

		chips.dispose();
	});

	test('resolves the config schema without subscribing for a client-local composer draft, then subscribes once the host announces it', async () => {
		// The Agents window's composer draft has no backend session until its
		// first message is sent: subscribing would open a channel for a session
		// the host has never heard of. The composer keeps the same resource
		// across that send, so the host's `sessionAdded` is what tells the
		// chips the session finally exists.
		const sessionResource = URI.parse('agent-host-copilot:/draft-session');
		const backendSession = URI.parse('copilot:/draft-session');
		const provisionalService = {
			onDidChange: Event.None,
			get: () => undefined,
			getResolvedConfig: () => undefined,
		} as Partial<IAgentHostUntitledProvisionalSessionService> as IAgentHostUntitledProvisionalSessionService;
		const acquired: string[] = [];
		const resolveRequests: (string | undefined)[] = [];
		const resolved = new DeferredPromise<void>();
		const notifications = disposables.add(new Emitter<INotification>());
		const state: SessionState = {
			provider: 'copilot',
			title: 'Committed',
			status: ProtocolSessionStatus.Idle,
			lifecycle: SessionLifecycle.Ready,
			activeClients: [],
			chats: [],
			config: {
				schema: {
					type: 'object',
					properties: {
						generic: { type: 'string', title: 'Generic' },
						// Host state must not become editable composer chips.
						[SessionConfigKey.AgentMerge]: { type: 'object', title: 'Agent Merge' },
						[SessionConfigKey.AgentMergeController]: { type: 'object', title: 'Agent Merge Controller' },
					},
				},
				values: {},
			},
		};
		const agentHostService = new class extends mock<IAgentHostService>() {
			declare readonly _serviceBrand: undefined;

			override readonly onDidNotification = notifications.event;

			override getSubscription<T extends StateComponents>(_kind: T, resource: URI, owner: string): IReference<IAgentSubscription<ComponentToState[T]>> {
				// Scoped to the lane: the chips it renders are pickers with
				// subscriptions of their own, which this test does not police.
				if (owner === 'AgentHostGenericConfigChips') {
					acquired.push(resource.toString());
				}
				return {
					object: { ...createSubscription<ComponentToState[T]>(), value: state as ComponentToState[T] },
					dispose: () => { },
				};
			}

			override async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
				resolveRequests.push(params.provider);
				resolved.complete();
				return { schema: { type: 'object', properties: {} }, values: {} };
			}
		}();
		const widget = {
			viewModel: { sessionResource },
			onDidChangeViewModel: Event.None,
		} as Partial<IChatWidget> as IChatWidget;
		const workspaceContextService = { getWorkspace: () => ({ id: '', folders: [] }) } as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const newSessionFolderService = { getFolder: () => undefined, getDefaultFolder: () => undefined } as Partial<IAgentHostNewSessionFolderService> as IAgentHostNewSessionFolderService;
		// The sessions provider stops reporting the resource as a client-local
		// draft the moment the host announces the session it created.
		let isClientLocalDraft = true;
		const workingDirectoryResolver = {
			resolve: () => undefined,
			isNewSession: () => isClientLocalDraft,
		} as Partial<IAgentHostSessionWorkingDirectoryResolver> as IAgentHostSessionWorkingDirectoryResolver;
		// The lane instantiates one `AgentHostChatInputPicker` per generic
		// property, so the chip's own dependencies have to resolve.
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IAgentHostService, agentHostService);
		instantiationService.stub(IAgentHostSessionWorkingDirectoryResolver, workingDirectoryResolver);
		instantiationService.stub(IAgentHostUntitledProvisionalSessionService, provisionalService);
		instantiationService.stub(IAgentHostNewSessionFolderService, newSessionFolderService);
		instantiationService.stub(IWorkspaceContextService, workspaceContextService);
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IAgentHostEnablementService, {
			_serviceBrand: undefined,
			enabled: constObservable(true),
			managedSandboxEnforced: constObservable(false),
		});
		instantiationService.stub(IActionWidgetService, {} as IActionWidgetService);
		// The generic chip attaches a delayed hover to its trigger as soon as the
		// schema carries a title, so this needs the real method rather than `{}`.
		instantiationService.stub(IHoverService, new class extends mock<IHoverService>() {
			override setupDelayedHover() { return Disposable.None; }
		}());
		instantiationService.stub(IOpenerService, {} as IOpenerService);
		instantiationService.stub(IDialogService, {} as IDialogService);
		instantiationService.stub(IStorageService, {} as IStorageService);

		const chips = disposables.add(new AgentHostGenericConfigChips(
			widget,
			instantiationService,
			agentHostService,
			provisionalService,
			workingDirectoryResolver,
			workspaceContextService,
			newSessionFolderService,
		));
		const container = mainWindow.document.createElement('div');
		chips.render(container);
		await resolved.p;
		const beforeAnnouncement = { acquired: [...acquired], chips: container.childElementCount };

		isClientLocalDraft = false;
		notifications.fire({
			type: NotificationType.SessionAdded,
			channel: 'ahp-root://',
			summary: {
				resource: backendSession.toString(),
				provider: 'copilot',
				title: 'Committed',
				status: ProtocolSessionStatus.Idle,
				createdAt: new Date().toISOString(),
				modifiedAt: new Date().toISOString(),
			},
		});

		assert.deepStrictEqual({
			beforeAnnouncement,
			resolveRequests,
			acquired,
			chips: container.childElementCount,
		}, {
			beforeAnnouncement: { acquired: [], chips: 0 },
			resolveRequests: ['copilot'],
			acquired: [backendSession.toString()],
			chips: 1,
		});

		chips.dispose();
	});
});
