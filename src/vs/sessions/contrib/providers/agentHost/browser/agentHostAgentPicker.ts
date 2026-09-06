/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { agentHostAgentPickerStorageKey, resolveAgentHostAgent } from '../../../../../platform/agentHost/common/customAgents.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatMode } from '../../../../../workbench/contrib/chat/common/chatModes.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { logChangesToStateModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { ChatModeKind } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISession, ISessionAgentRef, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/** Former composer action id. Kept so tests can assert it is not on the Agents menus. */
export const AGENT_HOST_AGENT_PICKER_ACTION_ID = 'sessions.agentHost.agentPicker';

/**
 * Restores a stored custom agent onto untitled agent-host sessions and keeps
 * chat input-model mode in sync. The Agents composer no longer shows an
 * "Agent" chip for this — custom agents live in AI Customizations.
 */
class AgentHostAgentPickerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.agentHostAgentPicker';

	constructor(
		@ISessionsService sessionsService: ISessionsService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		let settingAgentInternally = false;

		const initAgentFromActiveSession = () => {
			const session = sessionsService.activeSession.get();
			this._initAgent(session, session?.mode.get()?.id, session?.status.get() === SessionStatus.Untitled, sessionsProvidersService, () => settingAgentInternally = true, () => settingAgentInternally = false);
		};
		const syncChatInputModeFromActiveSession = () => {
			const session = sessionsService.activeSession.get();
			const selectedAgentUri = session?.mode.get()?.id;
			this._syncChatInputMode(session, selectedAgentUri, sessionsProvidersService);
		};

		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			const selectedAgentUri = session?.mode.read(reader)?.id;
			const isUntitled = session?.status.read(reader) === SessionStatus.Untitled;
			this._syncChatInputMode(session, selectedAgentUri, sessionsProvidersService);
			this._initAgent(session, selectedAgentUri, isUntitled, sessionsProvidersService, () => settingAgentInternally = true, () => settingAgentInternally = false);
		}));
		this._register(this.chatWidgetService.onDidAddWidget(() => {
			syncChatInputModeFromActiveSession();
		}));
		this._register(this.chatWidgetService.onDidChangeFocusedSession(() => {
			syncChatInputModeFromActiveSession();
		}));

		const customAgentsListener = this._register(new MutableDisposable());
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			const provider = this._getProvider(session, sessionsProvidersService);
			customAgentsListener.value = provider?.onDidChangeCustomAgents(() => {
				if (!settingAgentInternally) {
					initAgentFromActiveSession();
				}
			});
		}));
	}

	private _getProvider(session: ISession | undefined, sessionsProvidersService: ISessionsProvidersService): IAgentHostSessionsProvider | undefined {
		if (!session) {
			return undefined;
		}
		const provider = sessionsProvidersService.getProvider(session.providerId);
		return provider && isAgentHostProvider(provider) ? provider : undefined;
	}

	private _syncChatInputMode(session: ISession | undefined, selectedAgentUri: string | undefined, sessionsProvidersService: ISessionsProvidersService): void {
		if (!session || !this._getProvider(session, sessionsProvidersService)) {
			return;
		}

		const chatModel = this.chatService.getSession(session.resource);
		const currentMode = chatModel?.inputModel.state.get()?.mode;
		const nextMode = selectedAgentUri ? { id: selectedAgentUri, kind: ChatModeKind.Agent } : { id: ChatMode.Agent.id, kind: ChatModeKind.Agent };
		if (currentMode?.id === nextMode.id && currentMode.kind === nextMode.kind) {
			this._syncVisibleChatInputMode(session, nextMode.id);
			return;
		}

		chatModel?.inputModel.setState({ mode: nextMode });
		this._syncVisibleChatInputMode(session, nextMode.id);
	}

	private _syncVisibleChatInputMode(session: ISession, modeId: string): void {
		const widget = this.chatWidgetService.getWidgetBySessionResource(session.resource);
		if (!widget) {
			return;
		}

		const currentMode = widget.input.currentModeObs.get();
		if (currentMode.id === modeId) {
			return;
		}

		const apply = async () => {
			await widget.input.currentChatModesObs.get().waitForPendingUpdates();
			if (widget.viewModel?.model.sessionResource.toString() !== session.resource.toString()) {
				return;
			}

			const mode = widget.input.currentChatModesObs.get().findModeById(modeId);
			if (!mode) {
				return;
			}

			const chatModel = this.chatService.getSession(session.resource);
			logChangesToStateModel(chatModel?.inputModel, `[AGPK] _syncVisibleChatInputMode -> widget.input.setChatMode(${modeId}) for ${session.resource.toString()}`, undefined, chatModel?.inputModel.state.get(), this.logService);
			widget.input.setChatMode(modeId, false);
		};

		apply().catch(err => this.logService.error('[AgentHostAgentPickerProbe] sync visible chat input mode failed', err));
	}

	private _initAgent(
		session: ISession | undefined,
		selectedAgentUri: string | undefined,
		isUntitled: boolean,
		sessionsProvidersService: ISessionsProvidersService,
		beginInternalSet: () => void,
		endInternalSet: () => void,
	): void {
		const provider = this._getProvider(session, sessionsProvidersService);
		if (!session || !provider) {
			return;
		}

		const agents = provider.getCustomAgents(session.sessionId);
		const storedUri = isUntitled
			? this.storageService.get(agentHostAgentPickerStorageKey(session.resource.scheme), StorageScope.PROFILE)
			: undefined;
		const resolved = resolveAgentHostAgent(agents, selectedAgentUri, storedUri);

		if (!selectedAgentUri && isUntitled && resolved) {
			beginInternalSet();
			try {
				this._setAgent(session, provider, resolved);
			} finally {
				endInternalSet();
			}
		} else if (selectedAgentUri && !resolved && agents.length > 0 && !isUntitled) {
			beginInternalSet();
			try {
				this._setAgent(session, provider, undefined);
			} finally {
				endInternalSet();
			}
		}
	}

	private _setAgent(session: ISession, provider: IAgentHostSessionsProvider, agent: ISessionAgentRef | undefined): void {
		const key = agentHostAgentPickerStorageKey(session.resource.scheme);
		if (agent) {
			this.storageService.store(key, agent.uri, StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(key, StorageScope.PROFILE);
		}
		provider.setAgent?.(session.sessionId, agent ? { uri: agent.uri, name: agent.name } : undefined);
	}
}

registerWorkbenchContribution2(AgentHostAgentPickerContribution.ID, AgentHostAgentPickerContribution, WorkbenchPhase.AfterRestored);
