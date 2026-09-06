/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IAgentCustomizationSettingsDescriptor } from '../../../../platform/agentHost/common/agentCustomizationSettings.js';
import { agentIcon, hookIcon, instructionsIcon, mcpServerIcon, pluginIcon, skillIcon, toolsIcon } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationIcons.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ISessionType } from '../../../services/sessions/common/session.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import {
	accountKindForSessionType,
	agentNavId,
	CUSTOMIZATION_OVERVIEW_SECTION,
	customizationNavId,
	defaultProviderIdForUnadvertisedAgent,
	enabledSettingIdForSessionType,
	fallbackAgentLabel,
	GENERAL_NAV_ID,
	identityRootKeysForSessionType,
	MODELS_NAV_ID,
	REMOTE_HOSTS_NAV_ID,
	parseAgentNavId,
	parseCustomizationNavId,
	runtimeSettingIdsForSessionType,
	type AgentSettingsAccountKind,
	type AgentSettingsNavId,
	type CustomizationSettingsNavId,
} from './agentSettings.js';

export interface IAdvertisedAgentHostType {
	readonly providerId: string;
	readonly sessionType: ISessionType;
}

export interface IAgentSettingsCatalogInput {
	/** `product.sessionsAllowedAgentHostProviders`; `undefined` means no product allowlist. */
	readonly allowedProviderIds: readonly string[] | undefined;
	readonly advertised: readonly IAdvertisedAgentHostType[];
	readonly agentHostProviderIds: ReadonlySet<string>;
	readonly configurationKeys: ReadonlySet<string>;
	readonly rootConfigKeys: ReadonlySet<string>;
	readonly customizationByProvider: ReadonlyMap<string, IAgentCustomizationSettingsDescriptor>;
}

export interface IAgentSettingsAgent {
	readonly navId: AgentSettingsNavId;
	readonly sessionTypeId: string;
	readonly providerId: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly chatSessionType: string;
	readonly advertised: boolean;
	readonly enabledSettingId: string | undefined;
	readonly accountKind: AgentSettingsAccountKind | undefined;
	readonly runtimeSettingIds: readonly string[];
	readonly identityRootKeys: readonly string[];
	readonly customization: IAgentCustomizationSettingsDescriptor | undefined;
}

export interface IAgentSettingsCatalog {
	readonly agents: readonly IAgentSettingsAgent[];
}

export type AgentSettingsCustomizationSection = typeof CUSTOMIZATION_OVERVIEW_SECTION | AICustomizationManagementSection;

export interface IAgentSettingsCustomizationNavItem {
	readonly navId: CustomizationSettingsNavId;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly section: AgentSettingsCustomizationSection;
}

export interface IAgentSettingsNavItem {
	readonly navId: AgentSettingsNavId;
	readonly label: string;
	readonly icon?: ThemeIcon;
}

export interface IAgentSettingsNavGroup {
	readonly heading: string;
	readonly items: readonly IAgentSettingsNavItem[];
}

export interface IAgentSettingsNavGroupLabels {
	readonly generalHeading: string;
	readonly generalItem: string;
	readonly modelsItem: string;
	readonly remoteHostsItem: string;
	readonly agentsHeading: string;
	readonly customizationsHeading: string;
}

export type AgentSettingsNavSelection =
	| { readonly kind: 'general' }
	| { readonly kind: 'models' }
	| { readonly kind: 'remoteHosts' }
	| { readonly kind: 'agent'; readonly sessionTypeId: string }
	| { readonly kind: 'customization'; readonly section: AgentSettingsCustomizationSection };

/**
 * Settings Customizations entries follow the existing toolbar catalog, minus
 * Codex-only Harness Settings. Tools stays omitted unless the active harness
 * exposes it (Copilot CLI); Prompts is already absent from that catalog.
 */
const SETTINGS_CUSTOMIZATION_SECTIONS: readonly {
	readonly section: AgentSettingsCustomizationSection;
	readonly label: string;
	readonly icon: ThemeIcon;
}[] = [
		{ section: CUSTOMIZATION_OVERVIEW_SECTION, label: localize('overview', "Overview"), icon: Codicon.home },
		{ section: AICustomizationManagementSection.Agents, label: localize('agents', "Agents"), icon: agentIcon },
		{ section: AICustomizationManagementSection.Skills, label: localize('skills', "Skills"), icon: skillIcon },
		{ section: AICustomizationManagementSection.Instructions, label: localize('instructions', "Instructions"), icon: instructionsIcon },
		{ section: AICustomizationManagementSection.Hooks, label: localize('hooks', "Hooks"), icon: hookIcon },
		{ section: AICustomizationManagementSection.McpServers, label: localize('mcpServers', "MCP Servers"), icon: mcpServerIcon },
		{ section: AICustomizationManagementSection.Plugins, label: localize('plugins', "Plugins"), icon: pluginIcon },
		{ section: AICustomizationManagementSection.Tools, label: localize('tools', "Tools"), icon: toolsIcon },
	];

export function buildCustomizationNavItems(hiddenSections: ReadonlySet<string>): IAgentSettingsCustomizationNavItem[] {
	const items: IAgentSettingsCustomizationNavItem[] = [];
	for (const config of SETTINGS_CUSTOMIZATION_SECTIONS) {
		if (config.section !== CUSTOMIZATION_OVERVIEW_SECTION && hiddenSections.has(config.section)) {
			continue;
		}
		items.push({
			navId: customizationNavId(config.section),
			label: config.label,
			icon: config.icon,
			section: config.section,
		});
	}
	return items;
}

export function buildAgentSettingsNavGroups(
	agents: readonly IAgentSettingsAgent[],
	customizationItems: readonly IAgentSettingsCustomizationNavItem[],
	labels: IAgentSettingsNavGroupLabels,
): IAgentSettingsNavGroup[] {
	const groups: IAgentSettingsNavGroup[] = [{
		heading: labels.generalHeading,
		items: [
			{ navId: GENERAL_NAV_ID, label: labels.generalItem, icon: Codicon.settingsGear },
			{ navId: MODELS_NAV_ID, label: labels.modelsItem, icon: Codicon.server },
			{ navId: REMOTE_HOSTS_NAV_ID, label: labels.remoteHostsItem, icon: Codicon.remote },
		],
	}];
	if (agents.length) {
		groups.push({
			heading: labels.agentsHeading,
			items: agents.map(agent => ({
				navId: agent.navId,
				label: agent.label,
				icon: agent.icon,
			})),
		});
	}
	groups.push({
		heading: labels.customizationsHeading,
		items: customizationItems.map(item => ({
			navId: item.navId,
			label: item.label,
			icon: item.icon,
		})),
	});
	return groups;
}

export function resolveSettingsNavSelection(
	navId: AgentSettingsNavId,
	agents: readonly IAgentSettingsAgent[],
	customizationItems: readonly IAgentSettingsCustomizationNavItem[],
): AgentSettingsNavSelection {
	if (navId === GENERAL_NAV_ID) {
		return { kind: 'general' };
	}
	if (navId === MODELS_NAV_ID) {
		return { kind: 'models' };
	}
	if (navId === REMOTE_HOSTS_NAV_ID) {
		return { kind: 'remoteHosts' };
	}
	const sessionTypeId = parseAgentNavId(navId);
	if (sessionTypeId && agents.some(agent => agent.sessionTypeId === sessionTypeId)) {
		return { kind: 'agent', sessionTypeId };
	}
	const section = parseCustomizationNavId(navId);
	if (section && customizationItems.some(item => item.section === section)) {
		return { kind: 'customization', section: section as AgentSettingsCustomizationSection };
	}
	return { kind: 'general' };
}

/**
 * Builds the Settings catalog from advertised session types, the product
 * allowlist, and schema/capability tables. Missing capabilities stay omitted
 * so the shared form never branches on a provider id.
 */
export function buildAgentSettingsCatalog(input: IAgentSettingsCatalogInput): IAgentSettingsCatalog {
	const advertisedByType = new Map<string, IAdvertisedAgentHostType>();
	const advertisedProviderIds: string[] = [];
	for (const item of input.advertised) {
		if (!input.agentHostProviderIds.has(item.providerId)) {
			continue;
		}
		if (!advertisedProviderIds.includes(item.providerId)) {
			advertisedProviderIds.push(item.providerId);
		}
		const existing = advertisedByType.get(item.sessionType.id);
		if (!existing || preferProvider(item.providerId, existing.providerId)) {
			advertisedByType.set(item.sessionType.id, item);
		}
	}

	const orderedIds: string[] = [];
	const seen = new Set<string>();
	const pushId = (id: string) => {
		if (!id || seen.has(id)) {
			return;
		}
		seen.add(id);
		orderedIds.push(id);
	};

	if (input.allowedProviderIds) {
		for (const id of input.allowedProviderIds) {
			pushId(id);
		}
	} else {
		for (const id of advertisedByType.keys()) {
			pushId(id);
		}
	}

	const fallbackProviderId = defaultProviderIdForUnadvertisedAgent(advertisedProviderIds);
	const agents: IAgentSettingsAgent[] = orderedIds.map(sessionTypeId => {
		const advertised = advertisedByType.get(sessionTypeId);
		const enabledSettingId = enabledSettingIdForSessionType(sessionTypeId);
		const chatSessionType = advertised?.sessionType.chatSessionType
			?? advertised?.sessionType.id
			?? `agent-host-${sessionTypeId}`;
		return {
			navId: agentNavId(sessionTypeId),
			sessionTypeId,
			providerId: advertised?.providerId ?? fallbackProviderId,
			label: advertised?.sessionType.label || fallbackAgentLabel(sessionTypeId),
			icon: advertised?.sessionType.icon ?? Codicon.robot,
			chatSessionType,
			advertised: !!advertised,
			enabledSettingId: input.configurationKeys.has(enabledSettingId) ? enabledSettingId : undefined,
			accountKind: accountKindForSessionType(sessionTypeId),
			runtimeSettingIds: runtimeSettingIdsForSessionType(sessionTypeId, input.configurationKeys),
			identityRootKeys: identityRootKeysForSessionType(sessionTypeId, input.rootConfigKeys),
			customization: input.customizationByProvider.get(sessionTypeId),
		};
	});

	return { agents };
}

function preferProvider(candidate: string, existing: string): boolean {
	if (candidate === existing) {
		return false;
	}
	if (candidate === LOCAL_AGENT_HOST_PROVIDER_ID) {
		return true;
	}
	if (existing === LOCAL_AGENT_HOST_PROVIDER_ID) {
		return false;
	}
	return false;
}
