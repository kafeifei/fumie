/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

/**
 * Thin status line above the landing composer while any agent's SDK is
 * still being prepared by the agent host, or after a preparation failed.
 * One line per non-ready agent: installing agents show a spinner, failed
 * ones show the reason's availability and a retry link. Hidden entirely
 * (display:none) when every advertised agent is ready — the normal case.
 */
export class AgentSdkPrepBar extends Disposable {

	readonly domNode: HTMLElement;
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
	) {
		super();
		this.domNode = dom.append(container, dom.$('.sessions-agent-sdk-prep-bar'));
		this._register(this._sessionsManagementService.onDidChangeSessionTypes(() => this._render()));
		this._render();
	}

	private _render(): void {
		this._renderDisposables.clear();
		dom.clearNode(this.domNode);
		const pending = this._sessionsManagementService.getAllProviderSessionTypes()
			.filter(({ sessionType }) => sessionType.sdkReadiness !== undefined);
		this.domNode.classList.toggle('hidden', pending.length === 0);
		for (const { providerId, sessionType } of pending) {
			const readiness = sessionType.sdkReadiness!;
			const row = dom.append(this.domNode, dom.$('.sessions-agent-sdk-prep-row'));
			if (readiness.state === 'installing') {
				row.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
				dom.append(row, dom.$('span.sessions-agent-sdk-prep-label')).textContent =
					localize('agentSdkPrepBar.installing', "Setting up {0}…", sessionType.label);
			} else {
				row.appendChild(renderIcon(Codicon.warning));
				const label = dom.append(row, dom.$('span.sessions-agent-sdk-prep-label'));
				label.textContent = localize('agentSdkPrepBar.failed', "{0} setup failed", sessionType.label);
				if (readiness.error) {
					row.title = readiness.error;
				}
				const retry = dom.append(row, dom.$('a.sessions-agent-sdk-prep-retry'));
				retry.textContent = localize('agentSdkPrepBar.retry', "Retry");
				retry.tabIndex = 0;
				retry.setAttribute('role', 'button');
				const doRetry = () => {
					void this._sessionsProvidersService.getProvider(providerId)?.retryAgentSdkInstall?.(sessionType.id);
				};
				this._renderDisposables.add(dom.addDisposableListener(retry, dom.EventType.CLICK, doRetry));
				this._renderDisposables.add(dom.addStandardDisposableListener(retry, dom.EventType.KEY_DOWN, e => {
					if (e.keyCode === KeyCode.Enter || e.keyCode === KeyCode.Space) {
						doRetry();
					}
				}));
			}
		}
	}
}
