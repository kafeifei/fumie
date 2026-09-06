/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { AGENT_HOST_ENABLED_CONTEXT_KEY } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { SessionStatus } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { RemoteNameContext } from '../../../../common/contextkeys.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export class RestartLocalAgentHostAction extends Action2 {
	static readonly ID = 'workbench.action.chat.restartLocalAgentHost';

	constructor() {
		super({
			id: RestartLocalAgentHostAction.ID,
			title: localize2('restartLocalAgentHost', "Restart Local Agent Host"),
			category: Categories.Developer,
			f1: true,
			precondition: ContextKeyExpr.and(
				ChatContextKeys.enabled,
				AGENT_HOST_ENABLED_CONTEXT_KEY,
				RemoteNameContext.isEqualTo(''),
			),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const agentHostService = accessor.get(IAgentHostService);
		const dialogService = accessor.get(IDialogService);
		const logService = accessor.get(ILogService);

		// The restart kills the host process outright, so any turn that is
		// streaming or sitting on a confirmation dies with it. `InputNeeded` is a
		// superset of the `InProgress` bit, so one mask finds both.
		let running = 0;
		try {
			const sessions = await agentHostService.listSessions();
			running = sessions.filter(session => ((session.status ?? 0) & SessionStatus.InProgress) === SessionStatus.InProgress).length;
		} catch (error) {
			// A host too sick to list its sessions is one the user has every
			// reason to restart; the missing count must not block that.
			logService.warn(`[RestartLocalAgentHost] Could not read the session list before restarting: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (running > 0) {
			const { confirmed } = await dialogService.confirm({
				type: 'warning',
				message: localize('restartLocalAgentHost.confirm', "Restart the agent host now?"),
				detail: running === 1
					? localize('restartLocalAgentHost.confirm.detail.one', "One session is running. Restarting the agent host interrupts it.")
					: localize('restartLocalAgentHost.confirm.detail.many', "{0} sessions are running. Restarting the agent host interrupts them.", running),
				primaryButton: localize('restartLocalAgentHost.confirm.restart', "&&Restart"),
			});
			if (!confirmed) {
				return;
			}
		}
		return agentHostService.restartAgentHost();
	}
}
