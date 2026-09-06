/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../base/common/event.js';
import type { RootState } from './state/protocol/state.js';

/**
 * Private side-channel describing whether each agent's SDK is on disk yet, and
 * what the user can do about it. Rides `publishRootTransientValues` rather than
 * AHP proper, alongside `vscode.codexAccount`: the protocol files here are
 * generated and version-pinned, so promoting this is a cross-repo change.
 *
 * One key per agent rather than one key holding a map — transient values are a
 * shallow patch, so a shared key would let agents erase each other's entry.
 */
const AGENT_SDK_SETUP_STATUS_KEY_PREFIX = 'vscode.agentSdkSetup.status.';

export const AGENT_SDK_SETUP_DOWNLOAD_REQUEST_KEY = 'vscode.agentSdkSetup.downloadRequest';

/**
 * Ask an agent to start the official sign-in flow it declared.
 *
 * Always honoured, including while a sign-in is already running: the shell
 * cannot see what happens in the browser — a cancelled authorization, a closed
 * tab — so "already signing in" is only ever a display state, never a reason to
 * refuse. A repeat request abandons the running attempt and starts a fresh one.
 */
export const AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY = 'vscode.agentSdkSetup.signInRequest';

/** Ask an agent to abandon the sign-in flow it is running and go back to signed-out. */
export const AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY = 'vscode.agentSdkSetup.cancelSignInRequest';

/**
 * Ask an agent to recheck setup after an external credential change, such as an
 * exported key or a CLI login run outside Fumie.
 */
export const AGENT_SDK_SETUP_RELOAD_REQUEST_KEY = 'vscode.agentSdkSetup.reloadRequest';

/**
 * The slice of an agent's SDK setup that a model-provider presentation reads,
 * plus the two routes out of an unfinished one. The window's own agent host
 * publishes it through `IAgentSdkSetupService`; a remote host publishes its own
 * over its connection, and the presentation must not tell the user about this
 * machine's account when the models come from another one.
 */
export interface IAgentSdkSetupPresentationSource {
	readonly setups: readonly IAgentSdkSetupInfo[];
	readonly onDidChangeSetups: Event<readonly IAgentSdkSetupInfo[]>;
	requestDownload(agent: string): void;
	signIn(agent: string): void;
	/** Abandon a running sign-in and return the agent to signed-out. */
	cancelSignIn(agent: string): void;
}

export function agentSdkSetupStatusKey(agent: string): string {
	return `${AGENT_SDK_SETUP_STATUS_KEY_PREFIX}${agent}`;
}

/**
 * Whether the agent's SDK can be loaded without a network fetch.
 */
export type AgentSdkDownloadStatus = 'notDownloaded' | 'downloading' | 'ready';

/** The result of the agent's own authoritative account check. */
export type AgentSdkAccountStatus = 'unknown' | 'signingIn' | 'signedOut' | 'signedIn' | 'error';

/**
 * What an agent declares about its own setup. Capabilities, never UI: no
 * user-facing strings ride this channel, because localization belongs in the
 * workbench.
 */
export interface IAgentSdkSetupInfo {
	/** Agent/provider id, e.g. `'claude'`. */
	readonly agent: string;
	readonly download: AgentSdkDownloadStatus;
	/** Absent for agents that do not publish a first-party account check. */
	readonly accountStatus?: AgentSdkAccountStatus;
	/**
	 * Where the user can learn about or finish setup, including agents that also
	 * expose an in-app official sign-in flow.
	 */
	readonly setupDocsUrl?: string;
	/**
	 * Display name of the provider this agent can sign in to in-app, e.g.
	 * `'ChatGPT'`; absent means it has no such flow. A proper noun the workbench
	 * cannot invent, so it crosses the wire like `displayName` does and is
	 * interpolated into a localized template rather than shown raw.
	 */
	readonly signInProviderName?: string;
}

/** A request the workbench addresses to one agent, made unique so a repeat press is not swallowed. */
export interface IAgentSdkSetupRequest {
	readonly agent: string;
	readonly request: string;
}

export function isAgentSdkSetupRequestFor(value: unknown, agent: string): value is IAgentSdkSetupRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request: Partial<IAgentSdkSetupRequest> = value;
	return request.agent === agent && typeof request.request === 'string' && request.request.length > 0;
}

function readOne(value: unknown, agent: string): IAgentSdkSetupInfo | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const info: Partial<IAgentSdkSetupInfo> = value;
	if (info.download !== 'notDownloaded' && info.download !== 'downloading' && info.download !== 'ready') {
		return undefined;
	}
	return {
		agent,
		download: info.download,
		...(info.accountStatus === 'unknown'
			|| info.accountStatus === 'signingIn'
			|| info.accountStatus === 'signedOut'
			|| info.accountStatus === 'signedIn'
			|| info.accountStatus === 'error'
			? { accountStatus: info.accountStatus }
			: {}),
		setupDocsUrl: typeof info.setupDocsUrl === 'string' ? info.setupDocsUrl : undefined,
		signInProviderName: typeof info.signInProviderName === 'string' && info.signInProviderName.length > 0 ? info.signInProviderName : undefined,
	};
}

/**
 * Every agent that has published a setup status, in root-state key order. Agents
 * that have not published are absent rather than guessed at — there is no honest
 * default for "we were never told".
 */
export function readAgentSdkSetupInfos(state: RootState | undefined): readonly IAgentSdkSetupInfo[] {
	// The one sanctioned hop into the namespaced setup slots; every field read out
	// of them is validated in `readOne`.
	const meta = state?._meta;
	const values = state?.config?.values;
	const infos: IAgentSdkSetupInfo[] = [];
	const seen = new Set<string>();
	for (const bag of [values, meta]) {
		for (const key of Object.keys(bag ?? {})) {
			if (!key.startsWith(AGENT_SDK_SETUP_STATUS_KEY_PREFIX)) {
				continue;
			}
			const agent = key.slice(AGENT_SDK_SETUP_STATUS_KEY_PREFIX.length);
			if (!agent || seen.has(agent)) {
				continue;
			}
			const info = readOne(bag?.[key], agent);
			if (info) {
				seen.add(agent);
				infos.push(info);
			}
		}
	}
	return infos;
}

/**
 * The agents whose SDK the user has agreed to fetch, decoded from storage. A
 * malformed or absent record reads as "nobody consented", which costs at worst
 * one extra press of a button the user was about to press anyway.
 */
export function readConsentedSdkAgents(stored: string | undefined): ReadonlySet<string> {
	if (!stored) {
		return new Set();
	}
	try {
		const parsed: unknown = JSON.parse(stored);
		return new Set(Array.isArray(parsed) ? parsed.filter(agent => typeof agent === 'string') : []);
	} catch {
		return new Set();
	}
}

export function writeConsentedSdkAgents(agents: ReadonlySet<string>): string {
	return JSON.stringify([...agents]);
}

/**
 * Which agents should be asked to fetch their SDK without being offered a
 * button, given standing consent. The SDK version is pinned per build
 * and the cache keyed by version, so every update invalidates it — daily on
 * Insiders. Consent is to "this product downloads the Claude SDK", not to one
 * tarball, so re-asking would nag people who already said yes.
 *
 * It does not carry to a *different* agent: the button says "we need to
 * download the Codex Agent SDK", and pressing it is not permission to fetch
 * Claude's.
 *
 * `alreadyRequested` stops a failing download retrying forever: a failed fetch
 * republishes `notDownloaded`, and every status change re-runs this. A window is
 * the retry unit.
 */
export function resolveConsentedSdkDownloads(
	consentedAgents: ReadonlySet<string>,
	setups: readonly IAgentSdkSetupInfo[],
	alreadyRequested: ReadonlySet<string>,
): readonly string[] {
	return setups
		.filter(setup => setup.download === 'notDownloaded' && consentedAgents.has(setup.agent) && !alreadyRequested.has(setup.agent))
		.map(setup => setup.agent);
}
