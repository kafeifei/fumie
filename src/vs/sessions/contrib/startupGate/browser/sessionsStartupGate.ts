/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IAgentHostEnablementService } from '../../../../platform/agentHost/common/agentHostEnablementService.js';
import { AgentSdkStatusConfigKey, type AgentSdkStatusMap } from '../../../../platform/agentHost/common/agentHostSchema.js';
import { AgentHostStartupTimeoutMs } from '../../../../platform/agentHost/common/agentHostStartupTelemetry.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase, type IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import './media/sessionsStartupGate.css';

/** Milliseconds the dismissal fade runs before the overlay is detached. */
const FadeOutMs = 200;

const enum StepState {
	Pending,
	Done,
	Failed,
}

interface IGateStep {
	readonly id: string;
	readonly label: string;
	state: StepState;
	error?: string;
}

/**
 * Covers the Agents window until the core startup work has settled.
 *
 * The window itself is shown by Electron the moment it is created, and the
 * parts splash is torn down on the workbench's first layout — both happen well
 * before the Agent Host has connected, the model catalog has resolved, or the
 * session list has been served. Without this gate the user is handed a shell
 * whose pickers are empty and whose actions fail.
 *
 * The gate lists what it is waiting for rather than faking a percentage: the
 * existing perf marks stop at `code/didStartWorkbench`, so there is no honest
 * basis for a proportional bar. Steps that fail stop blocking (their row shows
 * the reason), and a hard timeout offers an explicit way in, so a broken host
 * can never lock the user out of the application.
 */
export class SessionsStartupGateContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsStartupGate';

	private readonly _steps: IGateStep[] = [
		{ id: 'agentHost', label: localize('startupGate.agentHost', "Connecting to the Agent Host"), state: StepState.Pending },
		{ id: 'models', label: localize('startupGate.models', "Loading the model catalog"), state: StepState.Pending },
		{ id: 'agents', label: localize('startupGate.agents', "Preparing agents"), state: StepState.Pending },
		{ id: 'sessions', label: localize('startupGate.sessions', "Loading sessions"), state: StepState.Pending },
	];

	private _overlay: HTMLElement | undefined;
	private _stepsContainer: HTMLElement | undefined;
	private _progressElement: HTMLElement | undefined;
	private _escapeContainer: HTMLElement | undefined;
	private _timedOut = false;
	private _dismissed = false;

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IAgentHostEnablementService private readonly _enablementService: IAgentHostEnablementService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// With the Agent Host disabled there is nothing to wait for and the
		// steps below would never settle — hand the window over immediately.
		if (!this._enablementService.enabled.get()) {
			return;
		}

		this._show();

		this._track('agentHost', this._whenAgentHostConnected())
			.then(connected => {
				if (this._dismissed) {
					return;
				}
				if (!connected) {
					// Nothing downstream can succeed without a connection, and
					// leaving these pending would hold the gate shut until the
					// timeout rather than releasing it on the failure we know about.
					const reason = localize('startupGate.noConnection', "The Agent Host did not connect.");
					this._setStepState('agents', StepState.Failed, reason);
					this._setStepState('sessions', StepState.Failed, reason);
					return;
				}
				// Both depend on a live connection, so they only start once the
				// host is up; that keeps their failures attributable.
				void this._track('agents', this._whenAgentSdksSettled());
				void this._track('sessions', this._agentHostService.listSessions().then(() => undefined));
			});

		void this._track('models', this._languageModelsService.whenReady);

		this._register(disposableTimeout(() => this._onTimeout(), AgentHostStartupTimeoutMs));
	}

	// ---- Waiting ------------------------------------------------------------

	/**
	 * Resolves once the host connection is live. Also covers the legacy data
	 * migration the host awaits before registering any provider: until that
	 * finishes there is no connection to observe.
	 */
	private _whenAgentHostConnected(): Promise<void> {
		if (this._isRootStateReady()) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			const store = this._register(new DisposableStore());
			const settle = () => {
				store.dispose();
				resolve();
			};
			store.add(this._agentHostService.onAgentHostStart(settle));
			store.add(this._agentHostService.rootState.onDidChange(settle));
		});
	}

	/** Resolves once no managed agent SDK is still installing. */
	private _whenAgentSdksSettled(): Promise<void> {
		if (this._areAgentSdksSettled()) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			const store = this._register(new DisposableStore());
			store.add(this._agentHostService.rootState.onDidChange(() => {
				if (this._areAgentSdksSettled()) {
					store.dispose();
					resolve();
				}
			}));
		});
	}

	private _isRootStateReady(): boolean {
		const value = this._agentHostService.rootState.value;
		return value !== undefined && !(value instanceof Error);
	}

	private _areAgentSdksSettled(): boolean {
		const value = this._agentHostService.rootState.value;
		if (value === undefined || value instanceof Error) {
			return false;
		}
		const raw = value.config?.values?.[AgentSdkStatusConfigKey];
		if (!raw || typeof raw !== 'object') {
			// The host publishes this map as soon as it manages any SDK; its
			// absence means there is nothing to install.
			return true;
		}
		return Object.values(raw as AgentSdkStatusMap).every(entry => entry?.state !== 'installing');
	}

	/** Runs `work`, marks the matching step, and re-renders. Never rejects. */
	private async _track(id: string, work: Promise<void>): Promise<boolean> {
		try {
			await work;
			this._setStepState(id, StepState.Done);
			return true;
		} catch (error) {
			this._logService.warn(`[sessions startup gate] Step '${id}' failed`, error);
			this._setStepState(id, StepState.Failed, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	private _setStepState(id: string, state: StepState, error?: string): void {
		const step = this._steps.find(candidate => candidate.id === id);
		if (!step || step.state !== StepState.Pending) {
			return;
		}
		step.state = state;
		step.error = error;
		this._renderSteps();
		this._dismissIfSettled();
	}

	/**
	 * Failed steps stop blocking: their row keeps the reason on screen, but a
	 * host that cannot start must not hold the window hostage.
	 */
	private _dismissIfSettled(): void {
		if (this._steps.every(step => step.state !== StepState.Pending)) {
			this._dismiss();
		}
	}

	private _onTimeout(): void {
		if (this._dismissed) {
			return;
		}
		this._timedOut = true;
		this._renderEscape();
	}

	// ---- Rendering ----------------------------------------------------------

	private _show(): void {
		const overlay = append(this._layoutService.mainContainer, $('div.sessions-startup-gate'));
		overlay.setAttribute('role', 'status');
		overlay.setAttribute('aria-busy', 'true');
		overlay.setAttribute('aria-label', localize('startupGate.label', "Starting up"));
		this._overlay = overlay;
		this._register({ dispose: () => overlay.remove() });

		const inner = append(overlay, $('div.sessions-startup-gate-inner'));
		append(inner, $(`div.sessions-startup-gate-icon${ThemeIcon.asCSSSelector(Codicon.agent)}`));
		append(inner, $('div.sessions-startup-gate-title')).textContent = localize('startupGate.title', "Starting up");
		this._stepsContainer = append(inner, $('div.sessions-startup-gate-steps'));
		this._progressElement = append(inner, $('div.sessions-startup-gate-progress'));
		this._escapeContainer = append(inner, $('div.sessions-startup-gate-escape'));

		this._renderSteps();
	}

	private _renderSteps(): void {
		const container = this._stepsContainer;
		if (!container) {
			return;
		}
		clearNode(container);

		for (const step of this._steps) {
			const row = append(container, $('div.sessions-startup-gate-step'));

			let icon: ThemeIcon;
			let spin = false;
			switch (step.state) {
				case StepState.Done:
					row.classList.add('done');
					icon = Codicon.check;
					break;
				case StepState.Failed:
					row.classList.add('failed');
					icon = Codicon.warning;
					break;
				default:
					icon = Codicon.loading;
					spin = true;
					break;
			}

			const iconElement = append(row, $('span.sessions-startup-gate-step-icon'));
			iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
			if (spin) {
				iconElement.classList.add('codicon-modifier-spin');
			}

			const body = append(row, $('div.sessions-startup-gate-step-body'));
			append(body, $('span.sessions-startup-gate-step-label')).textContent = step.label;
			if (step.error) {
				append(body, $('span.sessions-startup-gate-step-error')).textContent = step.error;
			}
		}

		const settled = this._steps.filter(step => step.state !== StepState.Pending).length;
		if (this._progressElement) {
			this._progressElement.textContent = localize('startupGate.progress', "{0} of {1} ready", settled, this._steps.length);
		}
	}

	/** Renders the "enter anyway" escape hatch once the timeout has elapsed. */
	private _renderEscape(): void {
		const container = this._escapeContainer;
		if (!container || !this._timedOut) {
			return;
		}
		clearNode(container);

		append(container, $('div.sessions-startup-gate-escape-note')).textContent =
			localize('startupGate.timeout', "Startup is taking longer than expected. The steps still spinning above have not finished.");

		const button = append(container, $('button.sessions-startup-gate-escape-button')) as HTMLButtonElement;
		button.textContent = localize('startupGate.enterAnyway', "Enter anyway");
		button.onclick = () => this._dismiss();
		button.focus();
	}

	private _dismiss(): void {
		if (this._dismissed) {
			return;
		}
		this._dismissed = true;

		const overlay = this._overlay;
		if (!overlay) {
			return;
		}
		overlay.classList.add('sessions-startup-gate-dismissed');
		overlay.setAttribute('aria-busy', 'false');
		this._register(disposableTimeout(() => overlay.remove(), FadeOutMs));
	}
}

registerWorkbenchContribution2(SessionsStartupGateContribution.ID, SessionsStartupGateContribution, WorkbenchPhase.BlockStartup);
