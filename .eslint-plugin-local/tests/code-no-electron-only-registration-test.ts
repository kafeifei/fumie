/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fixture for the code-no-electron-only-registration rule, linted as if it were an
// electron-browser file (see its `files` entry in eslint.config.js). Each
// `eslint-disable-next-line` marks a registration the rule must report: if the rule stops
// firing, ESLint reports the directive as unused and this file starts failing the lint.

import { Disposable } from '../../src/vs/base/common/lifecycle.js';
import { ipcRenderer } from '../../src/vs/base/parts/sandbox/electron-browser/globals.js';
import { Action2, registerAction2 } from '../../src/vs/platform/actions/common/actions.js';
import { IAgentHostByokLmHandler } from '../../src/vs/platform/agentHost/common/agentHostByokLm.js';
import { InstantiationType, registerSingleton } from '../../src/vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../src/vs/platform/log/common/log.js';
import { INativeHostService } from '../../src/vs/platform/native/common/native.js';
import { SessionsCopilotConfigSlashSubmitHandlerContribution } from '../../src/vs/sessions/contrib/chat/browser/copilotConfigSlashSubmitHandler.js';
import { RevealLocalFileLinkOpenerContribution } from '../../src/vs/sessions/contrib/chat/electron-browser/revealLocalFileLinkOpener.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../src/vs/workbench/common/contributions.js';
import { AgentHostByokLmHandler } from '../../src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostByokLmHandler.js';

// Reads an Electron-only global, so it belongs behind the Electron door.
class UsesIpcContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'test.usesIpc';
	constructor() {
		super();
		ipcRenderer.on('vscode:test', () => { });
	}
}

// Injects a native service, so it belongs behind the Electron door.
class InjectsNativeServiceContribution implements IWorkbenchContribution {
	static readonly ID = 'test.injectsNativeService';
	constructor(@INativeHostService nativeHostService: INativeHostService) {
		nativeHostService.getCursorScreenPoint();
	}
}

// Nothing here needs Electron; the web entry loses it for no reason.
class NeutralContribution implements IWorkbenchContribution {
	static readonly ID = 'test.neutral';
	constructor(@ILogService logService: ILogService) {
		logService.info('neutral');
	}
}

class NeutralAction extends Action2 {
	constructor() {
		super({ id: 'test.neutralAction', title: 'Neutral Action', f1: false });
	}
	run(): void { }
}

registerWorkbenchContribution2(UsesIpcContribution.ID, UsesIpcContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(InjectsNativeServiceContribution.ID, InjectsNativeServiceContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(RevealLocalFileLinkOpenerContribution.ID, RevealLocalFileLinkOpenerContribution, WorkbenchPhase.Eventually);
// Neutral, but it lives outside `neutralRoot`: its only consumer is created in an
// electron-browser file, so the web build genuinely does not want it.
registerSingleton(IAgentHostByokLmHandler, AgentHostByokLmHandler, InstantiationType.Delayed);

// eslint-disable-next-line local/code-no-electron-only-registration
registerWorkbenchContribution2(NeutralContribution.ID, NeutralContribution, WorkbenchPhase.AfterRestored);
// eslint-disable-next-line local/code-no-electron-only-registration
registerWorkbenchContribution2(SessionsCopilotConfigSlashSubmitHandlerContribution.ID, SessionsCopilotConfigSlashSubmitHandlerContribution, WorkbenchPhase.AfterRestored);
// eslint-disable-next-line local/code-no-electron-only-registration
registerAction2(NeutralAction);
// eslint-disable-next-line local/code-no-electron-only-registration
registerSingleton(ILogService, NeutralContribution, InstantiationType.Delayed);
