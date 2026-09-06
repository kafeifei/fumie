/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { AgentSdkState } from '../../../../platform/agentHost/common/agentHostSchema.js';
import { AgentHostConfigKey } from '../../../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { SessionConfigKey } from '../../../../platform/agentHost/common/sessionConfigKeys.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, STORAGE_KEY_REMEMBERED_SESSION_CONFIG_VALUES } from '../../../common/agentHostSessionsProvider.js';
import { STORAGE_KEY_LAST_SESSION_TYPE } from '../../chat/browser/sessionTypePicker.js';

export const OPEN_AGENT_SETTINGS_COMMAND_ID = 'sessions.settings.open';
export const CLOSE_AGENT_SETTINGS_COMMAND_ID = 'sessions.settings.close';

/**
 * Dismiss the Settings overlay so an editor (or chat) opened from it is not
 * hidden behind the modal. Call this *before* revealing the target surface:
 * overlay close restores the previously focused element, which would otherwise
 * steal focus back from a just-opened editor.
 */
export function closeAgentSettingsOverlay(commandService: ICommandService): void {
	void commandService.executeCommand(CLOSE_AGENT_SETTINGS_COMMAND_ID);
}

export const AGENT_HOST_SETTINGS_SCHEME = 'agent-host-settings';

export const GENERAL_NAV_ID = 'general';
export const MODELS_NAV_ID = 'models';
export const REMOTE_HOSTS_NAV_ID = 'remoteHosts';
export const CUSTOMIZATION_NAV_PREFIX = 'customization:';
export const CUSTOMIZATION_OVERVIEW_SECTION = 'overview';

export type CustomizationSettingsNavId = `${typeof CUSTOMIZATION_NAV_PREFIX}${string}`;
export type AgentSettingsNavId = typeof GENERAL_NAV_ID | typeof MODELS_NAV_ID | typeof REMOTE_HOSTS_NAV_ID | `agent:${string}` | CustomizationSettingsNavId;

export interface IStoredSessionTypePick {
	readonly providerId?: string;
	readonly sessionTypeId: string;
}

export const enum AgentSettingsAccountKind {
	CodexChatGPT = 'codexChatGPT',
}

const AGENT_SETTINGS_ACCOUNT_KINDS: ReadonlyMap<string, AgentSettingsAccountKind> = new Map([
	['codex', AgentSettingsAccountKind.CodexChatGPT],
]);

/**
 * Root-config keys that describe how an Agent authenticates or routes traffic.
 * Association to a pane is by whether the key name contains that Agent's id —
 * not by `if (provider === …)` branches in the shared form.
 */
export const IDENTITY_ROOT_CONFIG_KEYS: ReadonlySet<string> = new Set([
	AgentHostConfigKey.ClaudeUseCopilotProxy,
	AgentHostConfigKey.CodexUsageSource,
]);

const SKIPPED_RUNTIME_SETTING_SUFFIXES: ReadonlySet<string> = new Set([
	'enabled',
	'multiRootEnabled',
]);

/** What the Enablement section should say about a toggle the host has not caught up with. */
export const enum AgentRestartNotice {
	/** The toggle and the registration agree; say nothing. */
	None,
	/** Enabling is still plausibly in flight; ask again later. */
	Pending,
	/** Only an agent host restart can make this toggle hold. */
	RestartRequired,
}

export interface IAgentRestartNotice {
	readonly notice: AgentRestartNotice;
	/** For {@link AgentRestartNotice.Pending}: milliseconds until the answer can change on its own. */
	readonly retryInMs?: number;
}

/**
 * Decides whether an Agent's enable toggle needs the "restart to take effect"
 * row, given the toggle, whether the host advertises the Agent, and what is
 * still in flight.
 *
 * Turning an Agent on registers it in the running agent host, but turning one
 * off never unregisters it, and a hot registration can also fail outright (no
 * SDK, an install that did not finish). So a toggle that disagrees with
 * `advertised` needs a restart — except while enabling is still under way:
 * an SDK the host reports as `installing` will register itself when it
 * finishes, and a toggle this page just switched on is given a short grace
 * period covering the round trip to the host. A disagreement in the disabling
 * direction has nothing in flight and is reported immediately.
 */
export function resolveAgentRestartNotice(state: {
	readonly enabled: boolean;
	readonly advertised: boolean;
	readonly sdkState?: AgentSdkState;
	/** When the grace period of a toggle switched on by this page ends. */
	readonly hotEnableDeadline?: number;
	readonly now: number;
}): IAgentRestartNotice {
	if (state.enabled === state.advertised) {
		return { notice: AgentRestartNotice.None };
	}
	if (state.enabled) {
		if (state.sdkState === 'installing') {
			return { notice: AgentRestartNotice.Pending };
		}
		const retryInMs = (state.hotEnableDeadline ?? 0) - state.now;
		if (retryInMs > 0) {
			return { notice: AgentRestartNotice.Pending, retryInMs };
		}
	}
	return { notice: AgentRestartNotice.RestartRequired };
}

export function agentHostSettingsUri(providerId: string): URI {
	return URI.from({
		scheme: AGENT_HOST_SETTINGS_SCHEME,
		authority: providerId,
		path: '/settings.jsonc',
	});
}

export function enabledSettingIdForSessionType(sessionTypeId: string): string {
	return `chat.agentHost.${sessionTypeId}Agent.enabled`;
}

export function runtimeSettingPrefixForSessionType(sessionTypeId: string): string {
	return `chat.agentHost.${sessionTypeId}Agent.`;
}

export function agentNavId(sessionTypeId: string): AgentSettingsNavId {
	return `agent:${sessionTypeId}`;
}

export function parseAgentNavId(id: AgentSettingsNavId): string | undefined {
	return id.startsWith('agent:') ? id.slice('agent:'.length) : undefined;
}

export function customizationNavId(section: string): CustomizationSettingsNavId {
	return `${CUSTOMIZATION_NAV_PREFIX}${section}`;
}

export function parseCustomizationNavId(id: AgentSettingsNavId): string | undefined {
	return id.startsWith(CUSTOMIZATION_NAV_PREFIX) ? id.slice(CUSTOMIZATION_NAV_PREFIX.length) : undefined;
}

export function isCustomizationNavId(id: AgentSettingsNavId): id is CustomizationSettingsNavId {
	return id.startsWith(CUSTOMIZATION_NAV_PREFIX);
}

export function fallbackAgentLabel(sessionTypeId: string): string {
	if (!sessionTypeId) {
		return sessionTypeId;
	}
	return sessionTypeId.charAt(0).toUpperCase() + sessionTypeId.slice(1);
}

export function runtimeSettingIdsForSessionType(sessionTypeId: string, configurationKeys: ReadonlySet<string>): string[] {
	const prefix = runtimeSettingPrefixForSessionType(sessionTypeId);
	const ids: string[] = [];
	for (const key of configurationKeys) {
		if (!key.startsWith(prefix)) {
			continue;
		}
		const suffix = key.slice(prefix.length);
		if (!suffix || suffix.includes('.') || SKIPPED_RUNTIME_SETTING_SUFFIXES.has(suffix)) {
			continue;
		}
		ids.push(key);
	}
	return ids.sort();
}

export function identityRootKeysForSessionType(sessionTypeId: string, rootConfigKeys: ReadonlySet<string>): string[] {
	const needle = sessionTypeId.toLowerCase();
	return [...rootConfigKeys]
		.filter(key => IDENTITY_ROOT_CONFIG_KEYS.has(key) && key.toLowerCase().includes(needle))
		.sort();
}

export function accountKindForSessionType(sessionTypeId: string): AgentSettingsAccountKind | undefined {
	return AGENT_SETTINGS_ACCOUNT_KINDS.get(sessionTypeId);
}

export function readStoredSessionTypePick(storageService: IStorageService): IStoredSessionTypePick | undefined {
	const raw = storageService.get(STORAGE_KEY_LAST_SESSION_TYPE, StorageScope.PROFILE);
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as IStoredSessionTypePick;
		if (parsed && typeof parsed.sessionTypeId === 'string') {
			return typeof parsed.providerId === 'string'
				? { providerId: parsed.providerId, sessionTypeId: parsed.sessionTypeId }
				: { sessionTypeId: parsed.sessionTypeId };
		}
	} catch {
		return { sessionTypeId: raw };
	}
	return { sessionTypeId: raw };
}

export function writeStoredSessionTypePick(storageService: IStorageService, pick: IStoredSessionTypePick): void {
	const stored: IStoredSessionTypePick = pick.providerId
		? { providerId: pick.providerId, sessionTypeId: pick.sessionTypeId }
		: { sessionTypeId: pick.sessionTypeId };
	storageService.store(STORAGE_KEY_LAST_SESSION_TYPE, JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.MACHINE);
}

export function readRememberedSessionConfig(storageService: IStorageService): Record<string, unknown> {
	const values = storageService.getObject<Record<string, unknown>>(STORAGE_KEY_REMEMBERED_SESSION_CONFIG_VALUES, StorageScope.PROFILE, {});
	return values && typeof values === 'object' ? { ...values } : {};
}

export function writeRememberedSessionConfigValue(storageService: IStorageService, key: string, value: unknown): void {
	const next = readRememberedSessionConfig(storageService);
	if (value === undefined) {
		delete next[key];
	} else {
		next[key] = value;
	}
	storageService.store(STORAGE_KEY_REMEMBERED_SESSION_CONFIG_VALUES, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.MACHINE);
}

export function readRememberedIsolation(storageService: IStorageService): string | undefined {
	const value = readRememberedSessionConfig(storageService)[SessionConfigKey.Isolation];
	return typeof value === 'string' ? value : undefined;
}

export function defaultProviderIdForUnadvertisedAgent(advertisedProviderIds: readonly string[]): string {
	return advertisedProviderIds.includes(LOCAL_AGENT_HOST_PROVIDER_ID)
		? LOCAL_AGENT_HOST_PROVIDER_ID
		: advertisedProviderIds[0] ?? LOCAL_AGENT_HOST_PROVIDER_ID;
}
