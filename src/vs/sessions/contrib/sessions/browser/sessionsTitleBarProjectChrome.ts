/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableGenericMouseDownListener, addDisposableListener, EventHelper, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { pickNativeSessionFolder } from '../../chat/browser/newSessionFolderQuickPickAction.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { getSessionWorkspaceKind, ISession, SessionWorkspaceKind } from '../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const BRANCH_FILTER_THRESHOLD = 10;

type ITitleBarBranchItem = { readonly name?: string; readonly checked?: boolean };

export interface ITitleBarProjectChromeState {
	readonly folderLabel: string;
	readonly folderUri: URI | undefined;
	readonly folderPath: string | undefined;
	readonly hasFolder: boolean;
	readonly isQuickChat: boolean;
	readonly isCreated: boolean;
	readonly branchName: string | undefined;
	readonly gitDirty: boolean;
	readonly incomingChanges: number;
	readonly outgoingChanges: number;
	readonly uncommittedChanges: number;
	readonly worktreePending: boolean;
	readonly workspaceKind: SessionWorkspaceKind | undefined;
	readonly worktreeLabel: string | undefined;
	readonly showGit: boolean;
	readonly showWorktree: boolean;
	readonly canApplyToDraft: boolean;
	readonly supportsWorktree: boolean;
}

export function getTitleBarProjectChromeState(
	session: IActiveSession | undefined,
	supportsWorktree = false,
): ITitleBarProjectChromeState {
	const isQuickChat = session?.isQuickChat?.get() ?? false;
	const isCreated = session?.isCreated.get() ?? false;
	const worktreePending = session?.worktreePending?.get() ?? false;
	const workspace = isQuickChat ? undefined : session?.workspace.get();
	const folder = workspace?.folders[0];
	const hasFolder = !!folder;
	const git = worktreePending ? undefined : folder?.gitRepository;
	const workspaceKind = hasFolder ? getSessionWorkspaceKind(workspace, worktreePending) : undefined;
	const folderLabel = hasFolder
		? (workspace?.label || folder.name)
		: localize('sessions.titlebar.selectFolder', "Select Folder");

	let worktreeLabel: string | undefined;
	if (hasFolder && workspaceKind !== SessionWorkspaceKind.Virtual) {
		if (worktreePending) {
			worktreeLabel = localize('sessions.titlebar.creatingWorktree', "Creating worktree…");
		} else if (workspaceKind === SessionWorkspaceKind.Worktree) {
			worktreeLabel = localize('sessions.titlebar.worktree', "Worktree");
		} else if (supportsWorktree || !!git) {
			worktreeLabel = localize('sessions.titlebar.thisFolder', "This folder");
		}
	}

	return {
		folderLabel,
		folderUri: folder?.root,
		folderPath: worktreePending ? undefined : folder?.workingDirectory.fsPath,
		hasFolder,
		isQuickChat,
		isCreated,
		branchName: git?.branchName?.trim() || undefined,
		gitDirty: (git?.uncommittedChanges ?? 0) > 0,
		incomingChanges: git?.incomingChanges ?? 0,
		outgoingChanges: git?.outgoingChanges ?? 0,
		uncommittedChanges: git?.uncommittedChanges ?? 0,
		worktreePending,
		workspaceKind,
		worktreeLabel,
		showGit: hasFolder && !!git && !worktreePending,
		showWorktree: !!worktreeLabel,
		canApplyToDraft: !!session && !isCreated && !isQuickChat,
		supportsWorktree,
	};
}

export function getTitleBarProjectChromeRenderKey(chrome: ITitleBarProjectChromeState): string {
	return [
		chrome.isQuickChat ? '1' : '0',
		chrome.folderLabel,
		chrome.folderUri?.toString() ?? '',
		chrome.branchName ?? '',
		chrome.worktreeLabel ?? '',
		chrome.gitDirty ? '1' : '0',
		String(chrome.incomingChanges),
		String(chrome.outgoingChanges),
		chrome.worktreePending ? '1' : '0',
		chrome.supportsWorktree ? '1' : '0',
	].join('|');
}

/** Cursor-like git chip: `main* ↑1 ↓2`. */
export function formatTitleBarGitChipLabel(chrome: ITitleBarProjectChromeState): string | undefined {
	if (!chrome.showGit) {
		return undefined;
	}
	const branch = chrome.branchName ?? localize('sessions.titlebar.branch', "Branch");
	let label = chrome.gitDirty ? `${branch}*` : branch;
	const parts: string[] = [];
	if (chrome.outgoingChanges > 0) {
		parts.push(`↑${chrome.outgoingChanges}`);
	}
	if (chrome.incomingChanges > 0) {
		parts.push(`↓${chrome.incomingChanges}`);
	}
	if (parts.length > 0) {
		label = `${label} ${parts.join(' ')}`;
	}
	return label;
}

export async function applyTitleBarPickedFolder(
	folderUri: URI,
	sessionsService: ISessionsService,
	sessionsManagementService: ISessionsManagementService,
	sessionsPartService: ISessionsPartService,
): Promise<void> {
	const session = sessionsService.activeSession.get();
	const isUntitledWorkspaceSession = !!session && !session.isCreated.get() && !(session.isQuickChat?.get() ?? false);
	if (isUntitledWorkspaceSession) {
		const view = sessionsPartService.getSessionView(session.sessionId);
		if (view) {
			const resolved = sessionsManagementService.resolveWorkspace(folderUri, session.providerId);
			view.selectWorkspace(folderUri, resolved?.providerId ?? session.providerId);
			return;
		}
	}
	await sessionsService.openNewSession({ folderUri });
}

function sessionSupportsWorktree(session: IActiveSession | undefined, sessionsManagementService: ISessionsManagementService): boolean {
	const folderUri = session?.workspace.get()?.folders[0]?.root;
	if (!folderUri || !session) {
		return false;
	}
	const types = sessionsManagementService.getSessionTypesForFolder(folderUri);
	const match = types.find(entry => entry.sessionType.id === session.sessionType) ?? types[0];
	return match?.sessionType.supportsWorktreeConfiguration === true;
}

export function resolveTitleBarProjectChrome(
	session: IActiveSession | undefined,
	sessionsManagementService: ISessionsManagementService,
): ITitleBarProjectChromeState {
	return getTitleBarProjectChromeState(session, sessionSupportsWorktree(session, sessionsManagementService));
}

/**
 * Folder / git / worktree chips for the Agents titlebar. The session title stays
 * display text; these chips are the Cursor-like project chrome.
 */
export class SessionsTitleBarProjectChrome extends Disposable {

	private readonly _chipDisposables = this._register(new DisposableStore());
	private readonly _branchLoadCts = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IGitService private readonly gitService: IGitService,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
	}

	clear(): void {
		this._chipDisposables.clear();
		this._branchLoadCts.clear();
	}

	render(parent: HTMLElement, session: IActiveSession | undefined): void {
		this._chipDisposables.clear();
		const chrome = resolveTitleBarProjectChrome(session, this.sessionsManagementService);

		this._renderFolderChip(parent, chrome);
		if (chrome.showGit) {
			this._renderGitChip(parent, session, chrome);
		}
		if (chrome.showWorktree) {
			this._renderWorktreeChip(parent, chrome);
		}
	}

	private _renderFolderChip(parent: HTMLElement, chrome: ITitleBarProjectChromeState): void {
		const ariaLabel = chrome.hasFolder
			? localize('sessions.titlebar.folderAria', "Select folder, {0}", chrome.folderLabel)
			: localize('sessions.titlebar.selectFolderAria', "Select folder");
		const tooltip = chrome.folderPath
			?? localize('sessions.titlebar.selectFolderTooltip', "Choose a folder for this session");
		this._createChip(parent, {
			className: 'agent-sessions-titlebar-folder',
			icon: Codicon.folderCompact,
			label: chrome.folderLabel,
			ariaLabel,
			tooltip,
			interactive: true,
			showChevron: true,
			onClick: () => this._pickFolder(chrome.folderUri).catch(onUnexpectedError),
		});
	}

	private _renderGitChip(parent: HTMLElement, session: IActiveSession | undefined, chrome: ITitleBarProjectChromeState): void {
		const display = formatTitleBarGitChipLabel(chrome);
		if (!display) {
			return;
		}
		const branchLabel = chrome.branchName ?? localize('sessions.titlebar.branch', "Branch");
		const tooltipParts = [branchLabel];
		if (chrome.uncommittedChanges > 0) {
			tooltipParts.push(localize('sessions.titlebar.uncommitted', "{0} uncommitted", chrome.uncommittedChanges));
		}
		if (chrome.outgoingChanges > 0) {
			tooltipParts.push(localize('sessions.titlebar.outgoing', "{0} ahead", chrome.outgoingChanges));
		}
		if (chrome.incomingChanges > 0) {
			tooltipParts.push(localize('sessions.titlebar.incoming', "{0} behind", chrome.incomingChanges));
		}
		const interactive = this._canChangeBranch(session, chrome);
		this._createChip(parent, {
			className: 'agent-sessions-titlebar-git',
			icon: Codicon.gitBranchCompact,
			label: display,
			ariaLabel: localize('sessions.titlebar.branchAria', "Git branch, {0}", display),
			tooltip: tooltipParts.join('\n'),
			interactive,
			showChevron: interactive,
			onClick: interactive ? (chip) => this._pickBranch(chip, session, chrome).catch(onUnexpectedError) : undefined,
		});
	}

	private _renderWorktreeChip(parent: HTMLElement, chrome: ITitleBarProjectChromeState): void {
		const session = this.sessionsService.activeSession.get();
		const interactive = !chrome.worktreePending && this._canChangeWorktree(session, chrome);
		this._createChip(parent, {
			className: 'agent-sessions-titlebar-worktree',
			icon: chrome.workspaceKind === SessionWorkspaceKind.Worktree || chrome.worktreePending ? Codicon.worktreeCompact : Codicon.folderCompact,
			label: chrome.worktreeLabel!,
			ariaLabel: localize('sessions.titlebar.worktreeAria', "Worktree, {0}", chrome.worktreeLabel),
			tooltip: chrome.worktreePending
				? localize('sessions.titlebar.creatingWorktreeTooltip', "The session worktree is still being created.")
				: localize('sessions.titlebar.worktreeTooltip', "Switch between this folder and a new git worktree"),
			interactive,
			showChevron: interactive,
			onClick: interactive ? (chip) => this._pickWorktree(chip, chrome) : undefined,
		});
	}

	private _createChip(parent: HTMLElement, options: {
		readonly className: string;
		readonly icon: ThemeIcon;
		readonly label: string;
		readonly ariaLabel: string;
		readonly tooltip: string;
		readonly interactive: boolean;
		readonly showChevron: boolean;
		readonly onClick?: (chip: HTMLElement) => void;
	}): HTMLElement {
		const chip = parent.appendChild($('div.agent-sessions-titlebar-chip', {
			role: options.interactive ? 'button' : undefined,
			tabIndex: options.interactive ? '0' : undefined,
			'aria-label': options.ariaLabel,
		}));
		chip.classList.add(options.className);
		if (!options.interactive) {
			chip.classList.add('static');
		}
		const icon = chip.appendChild(renderIcon(options.icon));
		icon.setAttribute('aria-hidden', 'true');
		chip.appendChild($('span.agent-sessions-titlebar-chip-label')).textContent = options.label;
		if (options.showChevron) {
			const chevron = chip.appendChild(renderIcon(Codicon.chevronDown));
			chevron.setAttribute('aria-hidden', 'true');
		}

		this._chipDisposables.add(this.hoverService.setupDelayedHover(chip, { content: options.tooltip }));

		if (options.onClick) {
			this._chipDisposables.add(addDisposableGenericMouseDownListener(chip, e => {
				EventHelper.stop(e, true);
			}));
			this._chipDisposables.add(addDisposableListener(chip, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				options.onClick!(chip);
			}));
			this._chipDisposables.add(addDisposableListener(chip, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					EventHelper.stop(e, true);
					options.onClick!(chip);
				}
			}));
		}

		return chip;
	}

	private async _pickFolder(currentFolder: URI | undefined): Promise<void> {
		const folderUri = await pickNativeSessionFolder(this.fileDialogService, currentFolder);
		if (!folderUri) {
			return;
		}
		await this._applyFolder(folderUri);
	}

	private async _applyFolder(folderUri: URI): Promise<void> {
		await applyTitleBarPickedFolder(
			folderUri,
			this.sessionsService,
			this.sessionsManagementService,
			this.sessionsPartService,
		);
	}

	private _canChangeBranch(session: IActiveSession | undefined, chrome: ITitleBarProjectChromeState): boolean {
		if (!chrome.folderUri) {
			return false;
		}
		if (chrome.canApplyToDraft) {
			return !!this._provider(session)?.setBranch;
		}
		return true;
	}

	private _canChangeWorktree(session: IActiveSession | undefined, chrome: ITitleBarProjectChromeState): boolean {
		if (!chrome.folderUri) {
			return false;
		}
		if (chrome.canApplyToDraft) {
			return !!this._provider(session)?.setIsolationMode;
		}
		return chrome.supportsWorktree;
	}

	private _provider(session: ISession | undefined) {
		return session ? this.sessionsProvidersService.getProvider(session.providerId) : undefined;
	}

	private async _pickBranch(chip: HTMLElement, session: IActiveSession | undefined, chrome: ITitleBarProjectChromeState): Promise<void> {
		if (!chrome.folderUri || this.actionWidgetService.isVisible) {
			return;
		}

		const gitUri = session?.workspace.get()?.folders[0]?.gitRepository?.uri ?? chrome.folderUri;
		this._branchLoadCts.value?.cancel();
		const cts = this._branchLoadCts.value = new CancellationTokenSource();

		const loading: IActionListItem<ITitleBarBranchItem>[] = [{
			kind: ActionListItemKind.Action,
			label: localize('sessions.titlebar.loadingBranches', "Loading branches…"),
			disabled: true,
			item: {},
		}];
		this._showBranchWidget(chip, loading);

		try {
			const repo = await this.gitService.openRepository(gitUri);
			if (cts.token.isCancellationRequested || !this.actionWidgetService.isVisible) {
				return;
			}
			const refs = repo ? await repo.getRefs({ pattern: 'refs/heads' }, cts.token) : [];
			if (cts.token.isCancellationRequested || !this.actionWidgetService.isVisible) {
				return;
			}
			const branches = refs.map(ref => ref.name).filter((name): name is string => !!name);
			if (branches.length === 0) {
				this.actionWidgetService.updateItems([{
					kind: ActionListItemKind.Action,
					label: localize('sessions.titlebar.noBranches', "No local branches"),
					disabled: true,
					item: {},
				}]);
				return;
			}
			const items: IActionListItem<ITitleBarBranchItem>[] = branches.map(name => ({
				kind: ActionListItemKind.Action,
				label: name,
				group: { title: '', icon: Codicon.gitBranch },
				item: { name, checked: name === chrome.branchName || undefined },
			}));
			this.actionWidgetService.updateItems(items);
		} catch (err) {
			if (!cts.token.isCancellationRequested) {
				this.actionWidgetService.hide(true);
				onUnexpectedError(err);
			}
		}
	}

	private _showBranchWidget(chip: HTMLElement, items: readonly IActionListItem<ITitleBarBranchItem>[]): void {
		const delegate: IActionListDelegate<ITitleBarBranchItem> = {
			onSelect: item => {
				this.actionWidgetService.hide();
				if (item.name) {
					this._applyBranch(item.name).catch(onUnexpectedError);
				}
			},
			onHide: () => {
				if (chip.isConnected) {
					chip.focus();
				}
			},
		};
		this.actionWidgetService.show(
			'titleBarBranchPicker',
			false,
			items,
			delegate,
			chip,
			undefined,
			[],
			{
				getAriaLabel: item => item.label ?? '',
				getWidgetAriaLabel: () => localize('sessions.titlebar.branchPickerAria', "Branch picker"),
			},
			items.length > BRANCH_FILTER_THRESHOLD
				? { showFilter: true, filterPlaceholder: localize('sessions.titlebar.filterBranches', "Filter branches…") }
				: undefined,
		);
	}

	private async _applyBranch(branch: string): Promise<void> {
		const session = this.sessionsService.activeSession.get();
		const chrome = resolveTitleBarProjectChrome(session, this.sessionsManagementService);
		if (chrome.canApplyToDraft && session) {
			await this._provider(session)?.setBranch?.(session.sessionId, branch);
			return;
		}
		if (chrome.folderUri) {
			await this.sessionsService.openNewSession({ folderUri: chrome.folderUri, branch });
		}
	}

	private _pickWorktree(chip: HTMLElement, chrome: ITitleBarProjectChromeState): void {
		const usingWorktree = chrome.workspaceKind === SessionWorkspaceKind.Worktree;
		const folderAction = new Action(
			'sessions.titlebar.workInFolder',
			localize('sessions.titlebar.workInFolder', "This folder"),
			ThemeIcon.asClassName(Codicon.folderCompact),
			true,
			() => this._applyIsolation('workspace').catch(onUnexpectedError),
		);
		folderAction.checked = !usingWorktree;
		const worktreeAction = new Action(
			'sessions.titlebar.newWorktree',
			localize('sessions.titlebar.newWorktree', "New Worktree"),
			ThemeIcon.asClassName(Codicon.worktreeCompact),
			true,
			() => this._applyIsolation('worktree').catch(onUnexpectedError),
		);
		worktreeAction.checked = usingWorktree;

		this.contextMenuService.showContextMenu({
			getAnchor: () => chip,
			getActions: () => [folderAction, worktreeAction],
			getCheckedActionsRepresentation: () => 'radio',
		});
	}

	private async _applyIsolation(mode: 'worktree' | 'workspace'): Promise<void> {
		const session = this.sessionsService.activeSession.get();
		const chrome = resolveTitleBarProjectChrome(session, this.sessionsManagementService);
		if (chrome.canApplyToDraft && session) {
			await this._provider(session)?.setIsolationMode?.(session.sessionId, mode);
			return;
		}
		if (chrome.folderUri) {
			await this.sessionsService.openNewSession({ folderUri: chrome.folderUri, isolationMode: mode });
		}
	}
}
