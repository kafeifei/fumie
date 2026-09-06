/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { RemoteAgentHostEntryType } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IConfirmation, IConfirmationResult } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ITunnelDiscoveryOptions, ITunnelHostInfo, ITunnelInfo, ITunnelUserLimit } from '../../../../../platform/agentHost/common/tunnelAgentHost.js';
import { AgentHostFilterConnectionStatus, AgentHostFilterScope, IAgentHostFilterEntry } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { IRemoteAgentHostInventoryEntry, RemoteAgentHostInventoryState } from '../../../../services/remoteAgentHostInventory/common/remoteAgentHostInventory.js';
import { AgentSettingsRemoteHosts, selectOfflineTunnels, selectReportableLimits } from '../../browser/agentSettingsRemoteHosts.js';

/**
 * The dev tunnel manager on the Remote Connections page.
 *
 * Every state below is one the user can actually land in — signed out, no
 * sign-in at all in a browser, the feature turned off, a lookup that failed,
 * an account with nothing on it. A row that quietly disappears when a value is
 * missing is the failure mode this page has already shipped once, so each case
 * asserts on the text the user is left with, not just on the absence of a row.
 */
suite('Sessions - Agent Settings dev tunnels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function tunnel(overrides: Partial<ITunnelInfo> & Pick<ITunnelInfo, 'tunnelId' | 'name'>): ITunnelInfo {
		return {
			clusterId: 'use',
			tags: ['vscode-server-launcher', 'protocolv6'],
			protocolVersion: 6,
			hostConnectionCount: 0,
			...overrides,
		};
	}

	interface IHarnessOptions {
		readonly sessions?: readonly { readonly id: string; readonly label: string; readonly scopes: readonly string[] }[];
		readonly providerDeclared?: boolean;
		readonly tunnelScopes?: readonly string[];
		readonly tunnels?: readonly ITunnelInfo[];
		readonly listError?: Error;
		/** Left out entirely, the service answers `undefined`: a client that cannot ask. */
		readonly limits?: readonly ITunnelUserLimit[];
		readonly limitsError?: Error;
		readonly deleteError?: Error;
		readonly enabled?: boolean;
		readonly sharingInfo?: ITunnelHostInfo;
		readonly confirm?: boolean;
		readonly devices?: readonly IRemoteAgentHostInventoryEntry[];
		readonly hosts?: readonly IAgentHostFilterEntry[];
		/** The name the rename prompt comes back with; `undefined` is a cancelled prompt. */
		readonly renameAnswer?: string;
	}

	function createHarness(options: IHarnessOptions = {}) {
		const container = document.createElement('div');
		const confirmations: IConfirmation[] = [];
		const deleted: ITunnelInfo[] = [];
		const errors: { message: string; detail: string | undefined }[] = [];
		const createdSessions: string[] = [];
		const removedSessions: string[] = [];
		const listOptions: (ITunnelDiscoveryOptions | undefined)[] = [];
		const forgotten: IRemoteAgentHostInventoryEntry[] = [];
		const renamed: { entry: IRemoteAgentHostInventoryEntry; name: string | undefined }[] = [];
		const commands: { id: string; args: unknown[] }[] = [];
		const scopes_: AgentHostFilterScope[] = [];
		const reconnected: string[] = [];
		const disconnected: string[] = [];
		const menus: IAction[][] = [];

		const sessions = options.sessions ?? [];
		const scopes = options.tunnelScopes ?? ['read:user'];

		const page = new AgentSettingsRemoteHosts(
			// IRemoteAgentHostInventoryService
			{
				_serviceBrand: undefined,
				onDidChange: Event.None,
				list: () => [...(options.devices ?? [])],
				forget: async (entry: IRemoteAgentHostInventoryEntry) => { forgotten.push(entry); },
				rename: (entry: IRemoteAgentHostInventoryEntry, name: string | undefined) => { renamed.push({ entry, name }); },
				displayNameFor: () => undefined,
			} as never,
			// IDialogService
			{
				confirm: async (confirmation: IConfirmation): Promise<IConfirmationResult> => {
					confirmations.push(confirmation);
					return { confirmed: options.confirm ?? false };
				},
				error: async (message: string, detail?: string) => { errors.push({ message, detail }); },
			} as never,
			// ITunnelHostService
			{
				onDidChangeStatus: Event.None,
				onDidChangeClients: Event.None,
				isSharing: !!options.sharingInfo,
				isConnecting: false,
				sharingInfo: options.sharingInfo,
				startSharing: async () => { },
				stopSharing: async () => { },
				listClients: async () => [],
				disconnectClient: async () => { },
			} as never,
			// IClipboardService
			{ writeText: async () => { } } as never,
			// IOpenerService
			{ open: async () => true } as never,
			// ITunnelAgentHostService
			{
				onDidChangeTunnels: Event.None,
				listTunnels: async (listed?: ITunnelDiscoveryOptions) => {
					listOptions.push(listed);
					if (options.listError) {
						throw options.listError;
					}
					return [...(options.tunnels ?? [])];
				},
				listUserLimits: async () => {
					if (options.limitsError) {
						throw options.limitsError;
					}
					return options.limits;
				},
				canDeleteTunnels: true,
				deleteTunnel: async (target: ITunnelInfo) => {
					if (options.deleteError) {
						throw options.deleteError;
					}
					deleted.push(target);
				},
			} as never,
			// IAuthenticationService
			{
				onDidChangeDeclaredProviders: Event.None,
				declaredProviders: (options.providerDeclared ?? true) ? [{ id: 'github', label: 'GitHub' }] : [],
				getSessions: async (_id: string, requested?: readonly string[]) => sessions
					.filter(session => !requested || requested.every(scope => session.scopes.includes(scope)))
					.map(session => ({ id: session.id, accessToken: 'token', account: { id: session.id, label: session.label }, scopes: session.scopes })),
				createSession: async (id: string) => {
					createdSessions.push(id);
					return { id: 'new', accessToken: 'token', account: { id: 'new', label: 'new' }, scopes };
				},
				removeSession: async (_id: string, sessionId: string) => { removedSessions.push(sessionId); },
			} as never,
			// IProductService
			{ tunnelApplicationConfig: { authenticationProviders: { github: { scopes: [...scopes] } } } } as never,
			// IConfigurationService
			{ getValue: () => options.enabled ?? true } as never,
			// IContextMenuService
			{
				showContextMenu: (delegate: { getActions(): IAction[] }) => { menus.push(delegate.getActions()); },
			} as never,
			// IQuickInputService
			{ input: async () => options.renameAnswer } as never,
			// ICommandService
			{ executeCommand: async (id: string, ...args: unknown[]) => { commands.push({ id, args }); } } as never,
			// IAgentHostFilterService
			{
				onDidChange: Event.None,
				scope: { kind: 'all' },
				hosts: options.hosts ?? [],
				setScope: (scope: AgentHostFilterScope) => { scopes_.push(scope); },
				reconnect: (providerId: string) => { reconnected.push(providerId); },
				disconnect: (providerId: string) => { disconnected.push(providerId); },
			} as never,
			// IRemoteAgentHostService
			{ reconnect: (address: string) => { reconnected.push(address); } } as never,
			// ISSHRemoteAgentHostService
			{
				listSSHConfigHosts: async () => [],
				resolveSSHConfig: async () => { throw new Error('no ssh config in tests'); },
				connect: async () => { throw new Error('no ssh in tests'); },
			} as never,
			// IWSLRemoteAgentHostService
			{
				isWSLAvailable: async () => false,
				listDistros: async () => [],
				connect: async () => { throw new Error('no wsl in tests'); },
			} as never,
		);

		/**
		 * The context-menu stub only records the actions; the real service
		 * disposes them when the menu hides, so tests that opened one must.
		 */
		const disposeMenus = () => {
			for (const list of menus) {
				for (const action of list) {
					(action as { dispose?(): void }).dispose?.();
				}
			}
		};

		return {
			page, container, confirmations, deleted, errors, createdSessions, removedSessions, forgotten, renamed,
			commands, scopes: scopes_, reconnected, disconnected, menus, disposeMenus,
			listOptions: () => listOptions,
			listCalls: () => listOptions.length,
		};
	}

	function device(overrides: Partial<IRemoteAgentHostInventoryEntry> = {}): IRemoteAgentHostInventoryEntry {
		return {
			authority: 'localhost__4321',
			address: 'localhost:4321',
			label: 'build-box',
			kind: RemoteAgentHostEntryType.SSH,
			state: RemoteAgentHostInventoryState.Disconnected,
			cachedSessionCount: 0,
			lastConnectedAt: undefined,
			...overrides,
		};
	}

	function host(overrides: Partial<IAgentHostFilterEntry> = {}): IAgentHostFilterEntry {
		return {
			providerId: 'remote-localhost__4321-agenthost',
			label: 'build-box',
			address: 'localhost:4321',
			status: AgentHostFilterConnectionStatus.Connected,
			hasLiveConnection: true,
			...overrides,
		};
	}

	function deviceCards(container: HTMLElement): { name: string; detail: string; tone: string; buttons: string[]; badges: string[] }[] {
		return Array.from(container.querySelectorAll('.agent-settings-device-card')).map(card => ({
			name: card.querySelector('.agent-settings-device-name span')?.textContent ?? '',
			detail: card.querySelector('.agent-settings-device-detail')?.textContent ?? '',
			tone: card.querySelector('.agent-settings-status-dot')?.className.replace('agent-settings-status-dot', '').trim() ?? '',
			buttons: Array.from(card.querySelectorAll('.monaco-button')).map(button => button.textContent ?? ''),
			badges: Array.from(card.querySelectorAll('.agent-settings-badge')).map(badge => badge.textContent ?? ''),
		}));
	}

	/** Opens a card's `…` menu and reports what it offers. */
	function overflowActions(harness: { container: HTMLElement; menus: IAction[][] }, index = 0): string[] {
		const buttons = Array.from(harness.container.querySelectorAll('.agent-settings-icon-button'));
		assert.ok(buttons[index], `expected an overflow button at ${index}`);
		(buttons[index] as HTMLElement).click();
		return (harness.menus.at(-1) ?? []).map(action => action.label);
	}

	/** Lets the page's silent account and tunnel lookups finish and redraw. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	function rows(container: HTMLElement): { label: string; description: string; buttons: string[] }[] {
		return Array.from(container.querySelectorAll('.agent-settings-row')).map(row => ({
			label: row.querySelector('.agent-settings-label')?.textContent ?? '',
			description: row.querySelector('.agent-settings-description')?.textContent ?? '',
			buttons: Array.from(row.querySelectorAll('.monaco-button')).map(button => button.textContent ?? ''),
		}));
	}

	function findRow(container: HTMLElement, label: string) {
		const match = rows(container).find(row => row.label === label);
		assert.ok(match, `expected a row labelled '${label}', got: ${rows(container).map(r => r.label).join(' | ')}`);
		return match;
	}

	/** `IConfirmation.detail` is typed loosely; every dialog this page raises uses plain text. */
	function detailOf(confirmation: IConfirmation): string {
		assert.strictEqual(typeof confirmation.detail, 'string', 'expected a plain-text confirmation detail');
		return confirmation.detail as string;
	}

	function clickButton(container: HTMLElement, label: string): void {
		const button = Array.from(container.querySelectorAll('.monaco-button'))
			.find(candidate => candidate.textContent === label);
		assert.ok(button, `expected a '${label}' button`);
		(button as HTMLElement).click();
	}

	test('signed out says so and offers sign in, without ever listing tunnels', async () => {
		const harness = createHarness({ sessions: [] });
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, 'Not signed in');
		assert.ok(row.description.includes('GitHub'));
		assert.deepStrictEqual(row.buttons, ['Sign in']);
		assert.strictEqual(harness.listCalls(), 0, 'a signed-out page must not call the tunnel service');
		harness.page.dispose();
	});

	test('a client with no authentication provider says so instead of showing an empty list', async () => {
		const harness = createHarness({ providerDeclared: false });
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, 'Signing in is not available in this client');
		assert.ok(row.description.includes('desktop app'));
		assert.deepStrictEqual(row.buttons, [], 'an unusable state must not offer a dead button');
		assert.strictEqual(harness.listCalls(), 0);
		harness.page.dispose();
	});

	test('the feature being turned off is named, not reported as an empty account', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			enabled: false,
		});
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, 'Dev tunnels are turned off');
		assert.ok(row.description.includes('chat.remoteAgentHostsEnabled'));
		assert.strictEqual(harness.listCalls(), 0);
		harness.page.dispose();
	});

	test('signed in lists each tunnel with its id, cluster and state, and marks this machine', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			sharingInfo: { tunnelName: 'this-mac', tunnelId: 'aaa' },
			tunnels: [
				tunnel({ tunnelId: 'aaa', name: 'this-mac', clusterId: 'use', hostConnectionCount: 1 }),
				tunnel({ tunnelId: 'bbb', name: 'old-laptop', clusterId: 'weu' }),
			],
		});
		harness.page.render(harness.container);
		await settle();

		assert.strictEqual(findRow(harness.container, 'octocat').buttons[0], 'Sign out');
		assert.strictEqual(findRow(harness.container, '2 dev tunnels listed').buttons[0], 'Refresh');

		const mine = findRow(harness.container, 'this-mac');
		assert.strictEqual(mine.description, 'aaa · use · Online · Agent host · Hosted by this machine');
		assert.deepStrictEqual(mine.buttons, ['Delete']);

		const other = findRow(harness.container, 'old-laptop');
		assert.strictEqual(other.description, 'bbb · weu · Offline · Agent host');
		harness.page.dispose();
	});

	test('a tunnel this app cannot connect to is listed, and says what it is labelled', async () => {
		// The tunnel Fumie opens for the phone carries its own label, so the
		// old label-filtered listing never showed it — while it went on using
		// up the very allowance the user came here to free.
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [
				tunnel({ tunnelId: 'ccc', name: 'fumie-mobile-web', tags: ['fumie-mobile-web', 'mobile-abcdef0123'], protocolVersion: 2 }),
				tunnel({ tunnelId: 'ddd', name: 'nameless', tags: [] }),
			],
		});
		harness.page.render(harness.container);
		await settle();

		assert.deepStrictEqual(harness.listOptions(), [{ silent: true, includeAllTunnels: true }]);
		assert.strictEqual(
			findRow(harness.container, 'fumie-mobile-web').description,
			'ccc · use · Offline · Labelled fumie-mobile-web, mobile-abcdef0123',
		);
		assert.strictEqual(findRow(harness.container, 'nameless').description, 'ddd · use · Offline · No labels');
		harness.page.dispose();
	});

	test('an empty account is reported as empty, now that a failure is a failure', async () => {
		// The listing services used to swallow an enumeration error and return
		// nothing, so this row had to hedge about which of the two it was.
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [],
		});
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, '0 dev tunnels listed');
		assert.ok(row.description.includes('no tunnels for this account'), row.description);
		harness.page.dispose();
	});

	test('a listing that throws reports the reason and offers a retry', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			listError: new Error('tunnel service unreachable'),
		});
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, 'Could not list your dev tunnels');
		assert.strictEqual(row.description, 'tunnel service unreachable');
		assert.deepStrictEqual(row.buttons, ['Try again']);
		harness.page.dispose();
	});

	test('deleting always confirms first, and a declined confirmation deletes nothing', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
			confirm: false,
		});
		harness.page.render(harness.container);
		await settle();

		clickButton(harness.container, 'Delete');
		await settle();

		assert.strictEqual(harness.confirmations.length, 1);
		assert.strictEqual(harness.confirmations[0].message, `Delete dev tunnel 'old-laptop'?`);
		assert.deepStrictEqual(harness.deleted, []);
		harness.page.dispose();
	});

	test('confirming a delete removes exactly that tunnel', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
			confirm: true,
		});
		harness.page.render(harness.container);
		await settle();

		clickButton(harness.container, 'Delete');
		await settle();

		assert.deepStrictEqual(harness.deleted.map(t => t.tunnelId), ['bbb']);
		harness.page.dispose();
	});

	test('deleting the tunnel this machine hosts warns that the address goes with it', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			sharingInfo: { tunnelName: 'this-mac', tunnelId: 'aaa' },
			tunnels: [tunnel({ tunnelId: 'aaa', name: 'this-mac', hostConnectionCount: 1 })],
		});
		harness.page.render(harness.container);
		await settle();

		clickButton(harness.container, 'Delete');
		await settle();

		assert.ok(detailOf(harness.confirmations[0]).includes('hosting right now'), detailOf(harness.confirmations[0]));
		harness.page.dispose();
	});

	test('the bulk clean-up names every tunnel it would delete and never includes this machine', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			sharingInfo: { tunnelName: 'this-mac', tunnelId: 'aaa' },
			tunnels: [
				tunnel({ tunnelId: 'aaa', name: 'this-mac' }),
				tunnel({ tunnelId: 'bbb', name: 'old-laptop' }),
				tunnel({ tunnelId: 'ccc', name: 'ci-box' }),
				tunnel({ tunnelId: 'ddd', name: 'live-box', hostConnectionCount: 2 }),
			],
		});
		harness.page.render(harness.container);
		await settle();

		clickButton(harness.container, 'Remove offline');
		await settle();

		const detail = detailOf(harness.confirmations[0]);
		assert.strictEqual(harness.confirmations[0].message, 'Delete 2 dev tunnels?');
		assert.ok(detail.includes('old-laptop'), detail);
		assert.ok(detail.includes('ci-box'), detail);
		assert.ok(!detail.includes('this-mac'), 'the hosted tunnel must never be swept up');
		assert.ok(!detail.includes('live-box'), 'an online tunnel is not stale');
		harness.page.dispose();
	});

	test('a delete that fails is reported rather than swallowed', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
			confirm: true,
			deleteError: new Error('403 forbidden'),
		});
		harness.page.render(harness.container);
		await settle();

		clickButton(harness.container, 'Delete');
		await settle();

		assert.strictEqual(harness.errors.length, 1);
		assert.ok(harness.errors[0].detail?.includes('403 forbidden'), harness.errors[0].detail);
		harness.page.dispose();
	});

	test('signing out asks first and removes only the session, never a tunnel', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
			confirm: true,
		});
		harness.page.render(harness.container);
		await settle();

		clickButton(harness.container, 'Sign out');
		await settle();

		assert.strictEqual(harness.confirmations[0].message, `Sign out of 'octocat'?`);
		assert.ok(detailOf(harness.confirmations[0]).includes('No tunnel is deleted'), detailOf(harness.confirmations[0]));
		assert.deepStrictEqual(harness.removedSessions, ['s1']);
		assert.deepStrictEqual(harness.deleted, []);
		harness.page.dispose();
	});

	test('the quota is shown as the service reports it, without its internal name', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
			limits: [{ name: 'TunnelsPerUserPerCluster', current: 10, limit: 10 }],
		});
		harness.page.render(harness.container);
		await settle();

		assert.strictEqual(findRow(harness.container, 'Tunnel allowance').description, '10 of 10 tunnels in use.');
		assert.ok(
			!rows(harness.container).some(row => row.label.includes('TunnelsPerUserPerCluster') || row.description.includes('TunnelsPerUserPerCluster')),
			'the service\'s own name for the limit is a tooltip, not copy',
		);
		const tooltip = Array.from(harness.container.querySelectorAll<HTMLElement>('.agent-settings-row'))
			.find(row => row.title.includes('TunnelsPerUserPerCluster'));
		assert.ok(tooltip, 'the term is still within reach for a support thread');
		harness.page.dispose();
	});

	test('a client that cannot ask for the quota shows no number at all', async () => {
		// The figure this page was asked for is the one thing it must not
		// invent: counting the rows would be wrong for any other cluster or
		// client, and wrong quietly.
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
		});
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, 'The tunnel allowance is not available here');
		assert.ok(row.description.includes('reports no limits'), row.description);
		assert.deepStrictEqual(row.buttons, [], 'a state the page cannot act on must not offer a button');
		assert.ok(!rows(harness.container).some(other => other.description.includes(' in use.')), 'no invented quota figure');
		harness.page.dispose();
	});

	test('a quota lookup that fails says why and offers a retry, without blanking the list', async () => {
		const harness = createHarness({
			sessions: [{ id: 's1', label: 'octocat', scopes: ['read:user'] }],
			tunnels: [tunnel({ tunnelId: 'bbb', name: 'old-laptop' })],
			limitsError: new Error('403 forbidden'),
		});
		harness.page.render(harness.container);
		await settle();

		const row = findRow(harness.container, 'Could not read the tunnel allowance');
		assert.strictEqual(row.description, '403 forbidden');
		assert.deepStrictEqual(row.buttons, ['Try again']);
		findRow(harness.container, 'old-laptop');
		harness.page.dispose();
	});

	test('selectReportableLimits keeps only the allowances the service put a number on', () => {
		assert.deepStrictEqual(
			selectReportableLimits([
				{ name: 'TunnelsPerUserPerCluster', current: 10, limit: 10 },
				{ name: 'Unlimited', current: 3 },
			]).map(limit => limit.name),
			['TunnelsPerUserPerCluster'],
		);
	});

	test('selectOfflineTunnels keeps online tunnels and the hosted one out of a sweep', () => {
		const tunnels = [
			tunnel({ tunnelId: 'aaa', name: 'this-mac' }),
			tunnel({ tunnelId: 'bbb', name: 'old-laptop' }),
			tunnel({ tunnelId: 'ccc', name: 'live-box', hostConnectionCount: 1 }),
		];

		assert.deepStrictEqual(
			selectOfflineTunnels(tunnels, { tunnelName: 'this-mac', tunnelId: 'aaa' }).map(t => t.tunnelId),
			['bbb'],
		);
		// An older CLI reports only the name, which is all `isTunnelHosted` then has to match on.
		assert.deepStrictEqual(
			selectOfflineTunnels(tunnels, { tunnelName: 'this-mac' }).map(t => t.tunnelId),
			['bbb'],
		);
		assert.deepStrictEqual(
			selectOfflineTunnels(tunnels, undefined).map(t => t.tunnelId),
			['aaa', 'bbb'],
		);
	});

	/**
	 * The My Devices cards. Reachability, not storage state, decides the light
	 * and the primary action; the destructive paths confirm first; and the
	 * machine-scope handoff has to land in the filter service, not in a copy of
	 * its state.
	 */
	suite('device cards', () => {

		test('a remembered device with no provider gets a gray light and a Connect that dials its address', async () => {
			const harness = createHarness({ devices: [device()] });
			harness.page.render(harness.container);
			await settle();

			const cards = deviceCards(harness.container);
			assert.strictEqual(cards.length, 1);
			assert.strictEqual(cards[0].name, 'build-box');
			assert.ok(cards[0].detail.includes('SSH'), cards[0].detail);
			assert.ok(cards[0].detail.includes('localhost:4321'), cards[0].detail);
			assert.ok(cards[0].detail.includes('never connected'), cards[0].detail);
			assert.ok(cards[0].tone.includes('idle'), cards[0].tone);
			assert.deepStrictEqual(cards[0].buttons, ['Connect']);
			assert.deepStrictEqual(cards[0].badges, []);

			clickButton(harness.container, 'Connect');
			assert.deepStrictEqual(harness.reconnected, ['localhost:4321'], 'no provider: the host service dials the address');
			harness.disposeMenus();
			harness.page.dispose();
		});

		test('a live provider turns the light green, offers Disconnect, and Connect goes through the provider', async () => {
			const connected = createHarness({ devices: [device()], hosts: [host()] });
			connected.page.render(connected.container);
			await settle();
			assert.ok(deviceCards(connected.container)[0].tone.includes('connected'));
			assert.deepStrictEqual(deviceCards(connected.container)[0].buttons, ['Disconnect']);
			clickButton(connected.container, 'Disconnect');
			assert.deepStrictEqual(connected.disconnected, ['remote-localhost__4321-agenthost']);
			connected.disposeMenus();
			connected.page.dispose();

			const offline = createHarness({
				devices: [device()],
				hosts: [host({ status: AgentHostFilterConnectionStatus.Disconnected, hasLiveConnection: false })],
			});
			offline.page.render(offline.container);
			await settle();
			clickButton(offline.container, 'Connect');
			assert.deepStrictEqual(offline.reconnected, ['remote-localhost__4321-agenthost'], 'with a provider, Connect goes through it');
			offline.disposeMenus();
			offline.page.dispose();
		});

		test('an orphaned device is Unavailable and only offers a clean-up', async () => {
			const harness = createHarness({
				devices: [device({ state: RemoteAgentHostInventoryState.Orphaned, cachedSessionCount: 3 })],
			});
			harness.page.render(harness.container);
			await settle();

			const cards = deviceCards(harness.container);
			assert.deepStrictEqual(cards[0].badges, ['Unavailable']);
			assert.deepStrictEqual(cards[0].buttons, [], 'nothing to connect to must not offer a dead button');
			assert.deepStrictEqual(overflowActions(harness, 1), ['Clean up']);
			harness.disposeMenus();
			harness.page.dispose();
		});

		test('the overflow menu is rename / show sessions / remove, and show sessions only with a provider', async () => {
			const withHost = createHarness({ devices: [device()], hosts: [host()] });
			withHost.page.render(withHost.container);
			await settle();
			assert.deepStrictEqual(overflowActions(withHost, 1), ['Rename', 'Show Sessions', 'Remove']);
			withHost.disposeMenus();
			withHost.page.dispose();

			const withoutHost = createHarness({ devices: [device()] });
			withoutHost.page.render(withoutHost.container);
			await settle();
			assert.deepStrictEqual(overflowActions(withoutHost, 1), ['Rename', 'Remove']);
			withoutHost.disposeMenus();
			withoutHost.page.dispose();
		});

		test('rename goes through the prompt into the inventory, and a cancelled prompt renames nothing', async () => {
			const harness = createHarness({ devices: [device()], renameAnswer: 'Example' });
			harness.page.render(harness.container);
			await settle();

			overflowActions(harness, 1);
			const rename = harness.menus.at(-1)!.find(action => action.label === 'Rename')!;
			await rename.run();
			await settle();
			assert.strictEqual(harness.renamed.length, 1);
			assert.strictEqual(harness.renamed[0].name, 'Example');
			harness.disposeMenus();
			harness.page.dispose();

			const cancelled = createHarness({ devices: [device()] });
			cancelled.page.render(cancelled.container);
			await settle();
			overflowActions(cancelled, 1);
			await cancelled.menus.at(-1)!.find(action => action.label === 'Rename')!.run();
			await settle();
			assert.deepStrictEqual(cancelled.renamed, []);
			cancelled.disposeMenus();
			cancelled.page.dispose();
		});

		test('show sessions scopes the list to the device and closes the settings overlay', async () => {
			const harness = createHarness({ devices: [device()], hosts: [host()] });
			harness.page.render(harness.container);
			await settle();

			overflowActions(harness, 1);
			await harness.menus.at(-1)!.find(action => action.label === 'Show Sessions')!.run();

			assert.deepStrictEqual(harness.scopes, [{ kind: 'host', providerId: 'remote-localhost__4321-agenthost' }]);
			assert.deepStrictEqual(harness.commands.map(command => command.id), ['sessions.settings.close']);
			harness.disposeMenus();
			harness.page.dispose();
		});

		test('remove confirms first; declining forgets nothing, confirming forgets exactly that device', async () => {
			const declined = createHarness({ devices: [device()], confirm: false });
			declined.page.render(declined.container);
			await settle();
			overflowActions(declined, 1);
			await declined.menus.at(-1)!.find(action => action.label === 'Remove')!.run();
			await settle();
			assert.strictEqual(declined.confirmations.at(-1)?.message, 'Remove \'build-box\'?');
			assert.deepStrictEqual(declined.forgotten, []);
			declined.disposeMenus();
			declined.page.dispose();

			const confirmed = createHarness({ devices: [device()], confirm: true });
			confirmed.page.render(confirmed.container);
			await settle();
			overflowActions(confirmed, 1);
			await confirmed.menus.at(-1)!.find(action => action.label === 'Remove')!.run();
			await settle();
			assert.strictEqual(confirmed.forgotten.length, 1);
			confirmed.disposeMenus();
			confirmed.page.dispose();
		});

		test('Add Device opens the inline panel, not a command', async () => {
			const harness = createHarness();
			harness.page.render(harness.container);
			await settle();

			clickButton(harness.container, 'Add Device');
			await settle();

			assert.ok(harness.container.querySelector('.agent-settings-add-device'), 'expected the inline panel');
			const choices = Array.from(harness.container.querySelectorAll('.agent-settings-add-choice-label')).map(el => el.textContent);
			assert.ok(choices.includes('Address'), `expected an Address choice, got ${choices.join(', ')}`);
			assert.deepStrictEqual(harness.commands, [], 'the quick pick must not be involved');
			harness.disposeMenus();
			harness.page.dispose();
		});
	});
});
