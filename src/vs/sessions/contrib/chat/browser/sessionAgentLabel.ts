/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';

const SESSION_AGENT_LABEL_ID = 'sessions.chat.agentLabel';

/** The current chat's agent is fixed; this toolbar item only identifies it. */
export class SessionAgentLabel extends BaseActionViewItem {

	constructor(
		action: IAction,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
	) {
		super(undefined, action);
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([ChatContextKeys.agentSessionType.key]))) {
				this.updateLabel();
			}
		}));
		this._register(chatSessionsService.onDidChangeItemsProviders(() => this.updateLabel()));
	}

	override render(container: HTMLElement): void {
		// Do not install BaseActionViewItem's click/touch handlers on a static label.
		container.classList.add('sessions-chat-agent-item');
		this.element = dom.append(container, dom.$('span.sessions-chat-agent-label'));
		this.updateLabel();
	}

	override isEnabled(): boolean { return false; }

	protected override updateLabel(): void {
		if (!this.element) {
			return;
		}
		const sessionType = ChatContextKeys.agentSessionType.getValue(this.contextKeyService);
		const contribution = sessionType ? this.chatSessionsService.getChatSessionContribution(sessionType) : undefined;
		const label = contribution?.displayName ?? sessionType ?? '';
		const icon = contribution?.icon;
		const iconElement = URI.isUri(icon)
			? dom.$('img.sessions-chat-agent-icon', { src: FileAccess.uriToBrowserUri(icon).toString(true), alt: '' })
			: renderIcon(ThemeIcon.isThemeIcon(icon) ? icon : Codicon.terminal);
		iconElement.setAttribute('aria-hidden', 'true');
		dom.reset(this.element, iconElement, dom.$('span.sessions-chat-agent-name', undefined, label));
		this.element.title = localize('sessions.chat.agentLabel', "Agent: {0}", label);
		this.element.setAttribute('aria-disabled', 'true');
	}
}

class SessionAgentLabelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sessionsChatAgentLabel';

	constructor(@IActionViewItemService actionViewItemService: IActionViewItemService) {
		super();
		this._register(actionViewItemService.register(MenuId.ChatInput, SESSION_AGENT_LABEL_ID,
			(action, _options, instantiationService) => instantiationService.createInstance(SessionAgentLabel, action)));
		this._register(MenuRegistry.appendMenuItem(MenuId.ChatInput, {
			command: {
				id: SESSION_AGENT_LABEL_ID,
				title: localize('sessions.chat.agent', "Agent"),
				precondition: ContextKeyExpr.false(),
			},
			group: 'navigation',
			order: 2.9,
			when: ContextKeyExpr.and(IsSessionsWindowContext, ChatContextKeys.lockedToCodingAgent),
		}));
	}
}

registerWorkbenchContribution2(SessionAgentLabelContribution.ID, SessionAgentLabelContribution, WorkbenchPhase.AfterRestored);
