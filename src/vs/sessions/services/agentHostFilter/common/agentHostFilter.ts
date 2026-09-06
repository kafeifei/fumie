/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Connection status of a host surfaced in the host filter.
 */
export const enum AgentHostFilterConnectionStatus {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	Connected = 'connected',
}

/**
 * A single host entry the user can scope the sessions list to.
 */
export interface IAgentHostFilterEntry {
	/** The {@link ISession.providerId} of the host — stable filter key. */
	readonly providerId: string;
	/** Display name for the host. */
	readonly label: string;
	/** The raw host address (e.g. `localhost:4321`, `tunnel+abc123`). */
	readonly address: string;
	/** Current connection status for this host. */
	readonly status: AgentHostFilterConnectionStatus;
	/**
	 * Whether this host has a live transport right now. A tunnel host reports
	 * {@link AgentHostFilterConnectionStatus.Connected} as soon as the host is
	 * online, which is not the same as being connected to it, so surfaces that
	 * gate on sessions actually being usable must read this instead.
	 */
	readonly hasLiveConnection: boolean;
}

export const IAgentHostFilterService = createDecorator<IAgentHostFilterService>('agentHostFilterService');

/**
 * The machine the sessions list is scoped to.
 *
 * - `all` — no machine filter; sessions from every provider are shown.
 * - `local` — only sessions from non-remote providers (the local agent host
 *   and any other provider registered by this machine).
 * - `host` — only sessions of one remote agent host, keyed by its
 *   {@link ISession.providerId}.
 *
 * On web there is no local agent host, so the scope is normalized to a
 * concrete `host` whenever one is known (the pre-scope behavior).
 */
export type AgentHostFilterScope =
	| { readonly kind: 'all' }
	| { readonly kind: 'local' }
	| { readonly kind: 'host'; readonly providerId: string };

export function agentHostFilterScopeEquals(a: AgentHostFilterScope, b: AgentHostFilterScope): boolean {
	return a.kind === b.kind && (a.kind !== 'host' || b.kind !== 'host' || a.providerId === b.providerId);
}

/**
 * Tracks the machine scope used to filter the sessions list and other
 * workbench surfaces: all machines, the local machine, or one remote agent
 * host.
 */
export interface IAgentHostFilterService {
	readonly _serviceBrand: undefined;

	/** Fires when {@link scope} or {@link hosts} changes. */
	readonly onDidChange: Event<void>;

	/** Fires when {@link isDiscovering} changes. */
	readonly onDidChangeDiscovering: Event<void>;

	/** The current machine scope. */
	readonly scope: AgentHostFilterScope;

	/**
	 * The scoped host's providerId when {@link scope} is a `host` scope,
	 * `undefined` otherwise. Kept alongside {@link scope} for consumers that
	 * only care about single-host scoping (the web host picker and the
	 * workspace picker).
	 */
	readonly selectedProviderId: string | undefined;

	/** All known hosts the user can switch between. */
	readonly hosts: readonly IAgentHostFilterEntry[];

	/**
	 * `true` while a host re-discovery operation is in flight (any
	 * registered discovery handler has not yet resolved). Used by the
	 * host filter UX to show a progress indicator.
	 */
	readonly isDiscovering: boolean;

	/**
	 * Update the machine scope. A `host` scope whose `providerId` does not
	 * match a known host is ignored.
	 */
	setScope(scope: AgentHostFilterScope): void;

	/**
	 * Scope to one host. Equivalent to `setScope({ kind: 'host', providerId })`;
	 * ignored if `providerId` does not match a known host.
	 */
	setSelectedProviderId(providerId: string): void;

	/**
	 * Tear down any existing connection for the given host and start a
	 * fresh connect attempt. No-op if the host is unknown.
	 */
	reconnect(providerId: string): void;

	/**
	 * Tear down the active connection for the given host without forgetting
	 * the entry. No-op if the host is unknown or already disconnected.
	 */
	disconnect(providerId: string): void;

	/**
	 * Forget the given host: drop its cached sessions and remove the entry
	 * that would recreate it on the next launch. No-op if the host is
	 * unknown or does not support being forgotten.
	 */
	forget(providerId: string): void;

	/**
	 * Trigger every registered discovery handler and resolve once they
	 * have all settled. {@link isDiscovering} is `true` for the duration
	 * of the call. No-op when no handlers are registered.
	 */
	rediscover(): Promise<void>;

	/**
	 * Register a callback invoked when {@link rediscover} runs. Used by
	 * host providers (e.g. dev tunnels) to plug their own discovery
	 * routine into the shared host picker UX.
	 */
	registerDiscoveryHandler(handler: () => Promise<void>): IDisposable;
}
