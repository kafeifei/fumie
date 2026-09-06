/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentSdkSetupPresentationSource } from '../../../../platform/agentHost/common/agentSdkSetup.js';

export interface IAgentHostModelProviderPresentationContext {
	readonly hasModelSnapshot: boolean;
	readonly hasNativeModels: boolean;
}

export interface IAgentHostModelProviderPresentationStatus {
	readonly message: string;
	readonly severity: Severity;
	readonly action?: IAction;
	/** See {@link ILanguageModelProviderStatus.explicitActionOnly}. */
	readonly explicitActionOnly?: boolean;
}

export interface IAgentHostModelProviderPresentation {
	readonly onDidChange: Event<void>;
	provideStatus(context: IAgentHostModelProviderPresentationContext): IAgentHostModelProviderPresentationStatus | undefined;
}

export type AgentHostModelProviderPresentationFactory = (accessor: ServicesAccessor) => IAgentHostModelProviderPresentation;

/**
 * Builds the same presentation for an agent reached over a connection. The
 * window's services describe this machine, so a remote agent's presentation is
 * built from the setup status its own host publishes instead.
 */
export type AgentHostRemoteModelProviderPresentationFactory = (setup: IAgentSdkSetupPresentationSource) => IAgentHostModelProviderPresentation;

class AgentHostModelProviderPresentationRegistry {
	private readonly _factories = new Map<string, AgentHostModelProviderPresentationFactory>();
	private readonly _remoteFactories = new Map<string, AgentHostRemoteModelProviderPresentationFactory>();

	register(vendor: string, factory: AgentHostModelProviderPresentationFactory): IDisposable {
		if (this._factories.has(vendor)) {
			throw new Error(`An Agent Host model-provider presentation is already registered for ${vendor}`);
		}
		this._factories.set(vendor, factory);
		return toDisposable(() => {
			if (this._factories.get(vendor) === factory) {
				this._factories.delete(vendor);
			}
		});
	}

	get(vendor: string): AgentHostModelProviderPresentationFactory | undefined {
		return this._factories.get(vendor);
	}

	/** Keyed by agent provider id: a connection derives its own vendor from it. */
	registerRemote(provider: string, factory: AgentHostRemoteModelProviderPresentationFactory): IDisposable {
		if (this._remoteFactories.has(provider)) {
			throw new Error(`An Agent Host remote model-provider presentation is already registered for ${provider}`);
		}
		this._remoteFactories.set(provider, factory);
		return toDisposable(() => {
			if (this._remoteFactories.get(provider) === factory) {
				this._remoteFactories.delete(provider);
			}
		});
	}

	getRemote(provider: string): AgentHostRemoteModelProviderPresentationFactory | undefined {
		return this._remoteFactories.get(provider);
	}
}

export const agentHostModelProviderPresentationRegistry = new AgentHostModelProviderPresentationRegistry();
