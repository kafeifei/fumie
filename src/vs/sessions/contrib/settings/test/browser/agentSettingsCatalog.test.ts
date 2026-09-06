/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostConfigKey } from '../../../../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { SessionTypeAuthRequirement } from '../../../../services/sessions/common/session.js';
import { STORAGE_KEY_LAST_SESSION_TYPE } from '../../../chat/browser/sessionTypePicker.js';
import {
	agentNavId,
	enabledSettingIdForSessionType,
	identityRootKeysForSessionType,
	MODELS_NAV_ID,
	REMOTE_HOSTS_NAV_ID,
	parseAgentNavId,
	parseCustomizationNavId,
	resolveAgentRestartNotice,
	runtimeSettingIdsForSessionType,
	AgentRestartNotice,
	writeStoredSessionTypePick,
	readStoredSessionTypePick,
	AgentSettingsAccountKind,
} from '../../browser/agentSettings.js';
import { buildAgentSettingsCatalog, buildAgentSettingsNavGroups, buildCustomizationNavItems, resolveSettingsNavSelection } from '../../browser/agentSettingsCatalog.js';

suite('Sessions - Agent Settings catalog', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps allowlisted Agents even when they are not yet advertised', () => {
		const catalog = buildAgentSettingsCatalog({
			allowedProviderIds: ['codex', 'claude', 'deepseek'],
			advertised: [{
				providerId: 'local-agent-host',
				sessionType: {
					id: 'codex',
					label: 'Codex',
					icon: Codicon.openai,
					authRequirement: SessionTypeAuthRequirement.None,
					chatSessionType: 'agent-host-codex',
				},
			}],
			agentHostProviderIds: new Set(['local-agent-host']),
			configurationKeys: new Set([
				'chat.agentHost.codexAgent.enabled',
				'chat.agentHost.deepseekAgent.enabled',
			]),
			rootConfigKeys: new Set(),
			customizationByProvider: new Map(),
		});

		assert.deepStrictEqual(catalog.agents.map(agent => agent.sessionTypeId), ['codex', 'claude', 'deepseek']);
		assert.strictEqual(catalog.agents[0].advertised, true);
		assert.strictEqual(catalog.agents[1].advertised, false);
		assert.strictEqual(catalog.agents[1].label, 'Claude');
		assert.strictEqual(catalog.agents[2].enabledSettingId, 'chat.agentHost.deepseekAgent.enabled');
		assert.strictEqual(catalog.agents.find(agent => agent.sessionTypeId === 'claude')?.enabledSettingId, undefined);
	});

	test('does not keep advertised types outside the product allowlist', () => {
		const catalog = buildAgentSettingsCatalog({
			allowedProviderIds: ['codex'],
			advertised: [{
				providerId: 'local-agent-host',
				sessionType: {
					id: 'copilotcli',
					label: 'Copilot',
					icon: Codicon.copilot,
					authRequirement: SessionTypeAuthRequirement.GitHub,
				},
			}],
			agentHostProviderIds: new Set(['local-agent-host']),
			configurationKeys: new Set(),
			rootConfigKeys: new Set(),
			customizationByProvider: new Map(),
		});

		assert.deepStrictEqual(catalog.agents.map(agent => agent.sessionTypeId), ['codex']);
		assert.strictEqual(catalog.agents[0].advertised, false);
	});

	test('associates identity root keys by name, not by provider-id UI branches', () => {
		assert.deepStrictEqual(
			identityRootKeysForSessionType('claude', new Set([
				AgentHostConfigKey.ClaudeUseCopilotProxy,
				AgentHostConfigKey.CodexUsageSource,
				AgentHostConfigKey.DefaultShell,
			])),
			[AgentHostConfigKey.ClaudeUseCopilotProxy],
		);
		assert.deepStrictEqual(
			identityRootKeysForSessionType('codex', new Set([
				AgentHostConfigKey.ClaudeUseCopilotProxy,
				AgentHostConfigKey.CodexUsageSource,
			])),
			[AgentHostConfigKey.CodexUsageSource],
		);
		assert.deepStrictEqual(
			identityRootKeysForSessionType('deepseek', new Set([
				AgentHostConfigKey.ClaudeUseCopilotProxy,
				AgentHostConfigKey.CodexUsageSource,
			])),
			[],
		);
	});

	test('declares account management by Agent capability', () => {
		const catalog = buildAgentSettingsCatalog({
			allowedProviderIds: ['codex', 'claude', 'pi'],
			advertised: [],
			agentHostProviderIds: new Set(['local-agent-host']),
			configurationKeys: new Set(),
			rootConfigKeys: new Set(),
			customizationByProvider: new Map(),
		});

		assert.strictEqual(catalog.agents.find(agent => agent.sessionTypeId === 'codex')?.accountKind, AgentSettingsAccountKind.CodexChatGPT);
		assert.strictEqual(catalog.agents.find(agent => agent.sessionTypeId === 'claude')?.accountKind, undefined);
		assert.strictEqual(catalog.agents.find(agent => agent.sessionTypeId === 'pi')?.accountKind, undefined);
	});

	test('lists runtime settings from the configuration key prefix and hides enablement', () => {
		const keys = new Set([
			'chat.agentHost.codexAgent.enabled',
			'chat.agentHost.codexAgent.codexHome',
			'chat.agentHost.codexAgent.binaryPath',
			'chat.agentHost.codexAgent.multiRootEnabled',
			'chat.agentHost.codexAgent.sdkRoot',
			'chat.agentHost.claudeAgent.enabled',
		]);
		assert.deepStrictEqual(runtimeSettingIdsForSessionType('codex', keys), [
			'chat.agentHost.codexAgent.binaryPath',
			'chat.agentHost.codexAgent.codexHome',
			'chat.agentHost.codexAgent.sdkRoot',
		]);
		assert.strictEqual(enabledSettingIdForSessionType('codex'), 'chat.agentHost.codexAgent.enabled');
		assert.strictEqual(agentNavId('codex'), 'agent:codex');
	});

	test('prefers the local agent-host provider when the same type is advertised twice', () => {
		const catalog = buildAgentSettingsCatalog({
			allowedProviderIds: ['claude'],
			advertised: [
				{
					providerId: 'agenthost-remote',
					sessionType: {
						id: 'claude',
						label: 'Claude (remote)',
						icon: Codicon.mcp,
						authRequirement: SessionTypeAuthRequirement.None,
					},
				},
				{
					providerId: 'local-agent-host',
					sessionType: {
						id: 'claude',
						label: 'Claude',
						icon: Codicon.mcp,
						authRequirement: SessionTypeAuthRequirement.None,
						chatSessionType: 'agent-host-claude',
					},
				},
			],
			agentHostProviderIds: new Set(['local-agent-host', 'agenthost-remote']),
			configurationKeys: new Set(),
			rootConfigKeys: new Set(),
			customizationByProvider: new Map(),
		});

		assert.strictEqual(catalog.agents[0].providerId, 'local-agent-host');
		assert.strictEqual(catalog.agents[0].label, 'Claude');
		assert.strictEqual(catalog.agents[0].chatSessionType, 'agent-host-claude');
	});

	test('round-trips the New Session default Agent storage key', () => {
		const storage = store.add(new InMemoryStorageService());
		writeStoredSessionTypePick(storage, { providerId: 'local-agent-host', sessionTypeId: 'codex' });
		assert.deepStrictEqual(readStoredSessionTypePick(storage), {
			providerId: 'local-agent-host',
			sessionTypeId: 'codex',
		});
		assert.ok(storage.get(STORAGE_KEY_LAST_SESSION_TYPE, StorageScope.PROFILE));
	});

	test('keeps Customizations as its own nav group and does not mix Overview with Agents', () => {
		const catalog = buildAgentSettingsCatalog({
			allowedProviderIds: ['codex', 'claude'],
			advertised: [],
			agentHostProviderIds: new Set(['local-agent-host']),
			configurationKeys: new Set(),
			rootConfigKeys: new Set(),
			customizationByProvider: new Map(),
		});
		const customizationItems = buildCustomizationNavItems(new Set(['tools', 'prompts', 'harnessSettings']));
		const groups = buildAgentSettingsNavGroups(catalog.agents, customizationItems, {
			generalHeading: 'General',
			generalItem: 'General',
			modelsItem: 'Models', remoteHostsItem: 'Remote Connections',
			agentsHeading: 'Agents',
			customizationsHeading: 'Customizations',
		});

		assert.deepStrictEqual(groups.map(group => group.heading), ['General', 'Agents', 'Customizations']);
		assert.deepStrictEqual(groups[0].items.map(item => item.navId), ['general', 'models', 'remoteHosts']);
		assert.deepStrictEqual(groups[1].items.map(item => item.navId), ['agent:codex', 'agent:claude']);
		assert.deepStrictEqual(groups[2].items.map(item => item.navId), [
			'customization:overview',
			'customization:agents',
			'customization:skills',
			'customization:instructions',
			'customization:hooks',
			'customization:mcpServers',
			'customization:plugins',
		]);
		assert.ok(!groups[2].items.some(item => item.navId === 'customization:harnessSettings'));
		assert.ok(!groups[1].items.some(item => item.navId.startsWith('customization:')));
	});

	test('clicking a Customizations nav item selects that section', () => {
		const customizationItems = buildCustomizationNavItems(new Set(['tools']));
		assert.deepStrictEqual(
			resolveSettingsNavSelection('customization:skills', [], customizationItems),
			{ kind: 'customization', section: 'skills' },
		);
		assert.deepStrictEqual(
			resolveSettingsNavSelection('customization:overview', [], customizationItems),
			{ kind: 'customization', section: 'overview' },
		);
		assert.deepStrictEqual(
			resolveSettingsNavSelection('customization:mcpServers', [], customizationItems),
			{ kind: 'customization', section: 'mcpServers' },
		);
		assert.deepStrictEqual(
			resolveSettingsNavSelection('agent:codex', [{
				navId: 'agent:codex',
				sessionTypeId: 'codex',
				providerId: 'local-agent-host',
				label: 'Codex',
				icon: Codicon.openai,
				chatSessionType: 'agent-host-codex',
				advertised: true,
				enabledSettingId: undefined,
				accountKind: AgentSettingsAccountKind.CodexChatGPT,
				runtimeSettingIds: [],
				identityRootKeys: [],
				customization: undefined,
			}], customizationItems),
			{ kind: 'agent', sessionTypeId: 'codex' },
		);
	});

	test('Models sits in the General group and resolves to its own pane', () => {
		const customizationItems = buildCustomizationNavItems(new Set());
		const groups = buildAgentSettingsNavGroups([], customizationItems, {
			generalHeading: 'General',
			generalItem: 'General',
			modelsItem: 'Models', remoteHostsItem: 'Remote Connections',
			agentsHeading: 'Agents',
			customizationsHeading: 'Customizations',
		});

		assert.deepStrictEqual(groups[0].items.map(item => ({ navId: item.navId, label: item.label, hasIcon: !!item.icon })), [
			{ navId: 'general', label: 'General', hasIcon: true },
			{ navId: MODELS_NAV_ID, label: 'Models', hasIcon: true },
			{ navId: REMOTE_HOSTS_NAV_ID, label: 'Remote Connections', hasIcon: true },
		]);
		assert.deepStrictEqual(resolveSettingsNavSelection(MODELS_NAV_ID, [], customizationItems), { kind: 'models' });
		assert.deepStrictEqual(resolveSettingsNavSelection(REMOTE_HOSTS_NAV_ID, [], customizationItems), { kind: 'remoteHosts' });
		assert.deepStrictEqual(
			[parseAgentNavId(MODELS_NAV_ID), parseCustomizationNavId(MODELS_NAV_ID)],
			[undefined, undefined],
		);
	});

	test('hides Tools in Customizations when the active harness hides that section', () => {
		const hidden = buildCustomizationNavItems(new Set(['tools']));
		assert.ok(!hidden.some(item => item.section === 'tools'));
		const visible = buildCustomizationNavItems(new Set());
		assert.ok(visible.some(item => item.section === 'tools'));
		assert.deepStrictEqual(
			resolveSettingsNavSelection('customization:tools', [], hidden),
			{ kind: 'general' },
		);
		assert.deepStrictEqual(
			resolveSettingsNavSelection('customization:tools', [], visible),
			{ kind: 'customization', section: 'tools' },
		);
	});

	test('keeps the product allowlist order including Kimi', () => {
		const catalog = buildAgentSettingsCatalog({
			allowedProviderIds: ['codex', 'claude', 'kimi', 'deepseek'],
			advertised: [],
			agentHostProviderIds: new Set(['local-agent-host']),
			configurationKeys: new Set([
				'chat.agentHost.kimiAgent.enabled',
				'chat.agentHost.deepseekAgent.enabled',
			]),
			rootConfigKeys: new Set(),
			customizationByProvider: new Map(),
		});
		assert.deepStrictEqual(catalog.agents.map(agent => agent.sessionTypeId), ['codex', 'claude', 'kimi', 'deepseek']);
		assert.strictEqual(catalog.agents.find(agent => agent.sessionTypeId === 'kimi')?.enabledSettingId, 'chat.agentHost.kimiAgent.enabled');
	});

	suite('resolveAgentRestartNotice', () => {
		const NOW = 1_000_000;

		test('says nothing while the toggle and the registration agree', () => {
			assert.strictEqual(resolveAgentRestartNotice({ enabled: true, advertised: true, now: NOW }).notice, AgentRestartNotice.None);
			assert.strictEqual(resolveAgentRestartNotice({ enabled: false, advertised: false, now: NOW }).notice, AgentRestartNotice.None);
		});

		test('asks for a restart as soon as a registered Agent is switched off', () => {
			assert.strictEqual(
				resolveAgentRestartNotice({ enabled: false, advertised: true, hotEnableDeadline: NOW + 5_000, now: NOW }).notice,
				AgentRestartNotice.RestartRequired,
			);
		});

		test('waits out the grace period before calling a freshly enabled Agent stuck', () => {
			const pending = resolveAgentRestartNotice({ enabled: true, advertised: false, hotEnableDeadline: NOW + 2_000, now: NOW });
			assert.deepStrictEqual(pending, { notice: AgentRestartNotice.Pending, retryInMs: 2_000 });
			assert.strictEqual(
				resolveAgentRestartNotice({ enabled: true, advertised: false, hotEnableDeadline: NOW, now: NOW }).notice,
				AgentRestartNotice.RestartRequired,
			);
		});

		test('waits indefinitely while the Agent SDK is still installing', () => {
			assert.deepStrictEqual(
				resolveAgentRestartNotice({ enabled: true, advertised: false, sdkState: 'installing', now: NOW }),
				{ notice: AgentRestartNotice.Pending },
			);
			assert.strictEqual(
				resolveAgentRestartNotice({ enabled: true, advertised: false, sdkState: 'failed', now: NOW }).notice,
				AgentRestartNotice.RestartRequired,
			);
		});

		test('asks for a restart when an Agent enabled before this page opened never registered', () => {
			assert.strictEqual(
				resolveAgentRestartNotice({ enabled: true, advertised: false, now: NOW }).notice,
				AgentRestartNotice.RestartRequired,
			);
		});
	});
});
