/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import Severity from '../../../../../../base/common/severity.js';
import { localize } from '../../../../../../nls.js';
import { ConfigSchema, type AgentCapabilities, type AgentInfo, SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { readAgentModelPricingMeta } from '../../../../../../platform/agentHost/common/agentModelPricing.js';
import { readAgentModelByokHidden, readAgentModelByokIdentifier } from '../../../../../../platform/agentHost/common/agentModelByokMeta.js';
import { isSubscriptionCatalogModel, readAgentModelGroupId, readAgentModelSourceId } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { IAgentHostModelProviderPresentation } from '../../../../../services/agentHost/browser/agentHostModelProviderPresentation.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelConfigurationSchema, ILanguageModelProviderStatus } from '../../../common/languageModels.js';

/**
 * Returns whether an agent host provider exposes a synthetic "Auto" model to
 * fall back to.
 *
 * Today only the Copilot CLI harness exposes an Auto selection and can run
 * without an explicit model, so it shows "Auto" rather than a "No models
 * available" state when no models are listed. Other harnesses (Claude,
 * Codex, …) require an explicit model.
 *
 * `provider` is the underlying agent provider id (e.g. `'copilotcli'`,
 * `'claude'`, `'codex'`), not the `agent-host-<provider>` session type.
 *
 * TODO: hoist this capability onto the agent host protocol (e.g. a
 * `supportsAutoModel?: boolean` on `IAgentDescriptor` / `AgentInfo`) so each
 * agent declares its own value instead of this allow-list living in core.
 */
export function agentHostProviderSupportsAutoModel(provider: string): boolean {
	return provider === 'copilotcli';
}

/**
 * A model as this vendor publishes it: what the agent advertised, plus the
 * renderer's decision on whether the picker may offer it as a row.
 *
 * The flag is optional and absent means selectable, so a plain
 * {@link SessionModelInfo} list — what every other caller of
 * {@link AgentHostLanguageModelProvider.updateModels} has — is already one of
 * these.
 */
export interface IAgentVendorModel extends SessionModelInfo {
	readonly isUserSelectable?: boolean;
}

/**
 * Explicit ownership relationship for source-backed models published by this
 * provider. A provider without this option keeps the legacy independent
 * visibility behavior, which is required for remote hosts and older catalogs.
 */
export interface IAgentHostModelVisibilitySource {
	readonly namespace: string;
	readonly sourceId: string;
	readonly owner: boolean;
}

/**
 * The models an agent's own vendor publishes: everything it advertises, with
 * the rows that belong to a first-party subscription marked unselectable.
 *
 * A subscription's models reach the picker through the provider the user added
 * for that subscription, which stamps them with this same session type and so
 * routes them identically. Offering them here as well would list every one of
 * them twice, under two names, with no way to tell which row does what — and
 * would keep offering them to a user who has not added the subscription at all.
 * Dropping them outright is not the answer either: what model a session runs and
 * how wide its context window is are facts about the agent, not about what the
 * user has configured, and every consumer that resolves a running model through
 * the catalog goes blind the moment the row is missing. So the catalog registers
 * them and the picker does not list them. The host keeps publishing the whole
 * catalog; which half each vendor *offers* is decided here, in the renderer.
 *
 * Exported for unit testing.
 */
export function agentVendorModels(agent: AgentInfo): readonly IAgentVendorModel[] {
	return agent.models.map(model => isSubscriptionCatalogModel(agent.provider, model)
		? { ...model, isUserSelectable: false }
		: model);
}

/**
 * Exposes models available from the agent host process as selectable
 * language models in the chat model picker. Models are provided from
 * root state (via {@link AgentInfo.models}) rather than via RPC.
 */
export class AgentHostLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _models: readonly IAgentVendorModel[] = [];
	private _hasModelSnapshot = false;

	constructor(
		private readonly _sessionType: string,
		private readonly _vendor: string,
		private readonly _modelCatalog: NonNullable<AgentCapabilities['modelCatalog']> = 'owned',
		private readonly _presentation?: IAgentHostModelProviderPresentation,
		private readonly _visibilitySource?: IAgentHostModelVisibilitySource,
	) {
		super();
		if (this._presentation) {
			this._register(this._presentation.onDidChange(() => this._onDidChange.fire()));
		}
	}

	/**
	 * Called by {@link AgentHostContribution} when models change in root state.
	 */
	updateModels(models: readonly IAgentVendorModel[]): void {
		this._models = models;
		this._hasModelSnapshot = true;
		this._onDidChange.fire();
	}

	async provideLanguageModelChatStatus(_options: unknown, _token: CancellationToken): Promise<ILanguageModelProviderStatus | undefined> {
		if (this._modelCatalog === 'projected') {
			return undefined;
		}
		// Only the rows this vendor actually offers count: a catalog made up
		// entirely of models another vendor lists still leaves this one with
		// nothing to pick, which is what the status speaks to.
		const hasNativeModels = this._models.some(model => model.policyState !== 'disabled' && model.isUserSelectable !== false && readAgentModelByokIdentifier(model) === undefined);
		const presentationStatus = this._presentation?.provideStatus({
			hasModelSnapshot: this._hasModelSnapshot,
			hasNativeModels,
		});
		if (presentationStatus) {
			return presentationStatus;
		}
		if (hasNativeModels) {
			return undefined;
		}
		return this._hasModelSnapshot
			? { message: localize('agentHost.models.empty', "No models available"), severity: Severity.Warning }
			: { message: localize('agentHost.models.loading', "Loading models…"), severity: Severity.Info };
	}

	async provideLanguageModelChatInfo(_options: unknown, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return this._models
			.filter(m => m.policyState !== 'disabled')
			.map(m => {
				const pricing = readAgentModelPricingMeta(m);
				const multiplierNumeric = pricing.multiplierNumeric;
				// "Auto" advertises the auto-mode discount (detail) + description (tooltip). microsoft/vscode#321778, #321659.
				const isAuto = m.id === 'auto';
				const discountPercent = pricing.discountPercent;
				// Guard against a non-finite or out-of-range value from the open `_meta` bag so we never render
				// nonsense like "Infinity% discount"; the documented range is a whole number in (0, 100].
				const hasDiscount = typeof discountPercent === 'number' && discountPercent > 0 && discountPercent <= 100;
				const detail = isAuto && hasDiscount
					? localize('agentHost.auto.discount', "{0}% discount", discountPercent)
					: undefined;
				const tooltip = isAuto
					? ILanguageModelChatMetadata.getAutoModelDescription(hasDiscount ? discountPercent : undefined)
					: undefined;
				const modelGroup = this._modelGroupFor(m);
				const sourceModel = this._sourceModelFor(m);
				const byokModelIdentifier = readAgentModelByokIdentifier(m);
				// The host's own Manage Models visibility, carried so a client that has no
				// copy of that state can grey the row instead of dropping it.
				const byokModelHidden = readAgentModelByokHidden(m);
				return {
					identifier: `${this._vendor}:${m.id}`,
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: m.name,
						id: m.id,
						// The agent's own name for this model, when it publishes the row
						// under a decorated id; the only handle a turn replayed from a
						// transcript has to find this row by.
						...(m.underlyingModelId !== undefined && { underlyingModelId: m.underlyingModelId }),
						vendor: this._vendor,
						version: '1.0',
						family: m.id,
						...(tooltip !== undefined && { tooltip }),
						...(detail !== undefined && { detail }),
						// BYOK-bridge models carry only `maxContextWindow` (prompt +
						// output, from the renderer catalog); derive the input side
						// from it so the context-usage gauge has a denominator.
						maxInputTokens: m.maxPromptTokens ?? (m.maxContextWindow !== undefined ? Math.max(0, m.maxContextWindow - (m.maxOutputTokens ?? 0)) : 0),
						maxOutputTokens: m.maxOutputTokens ?? 0,
						isDefaultForLocation: {},
						// A row this vendor registers but does not offer (a subscription's
						// models, which its own provider offers instead) is still resolvable
						// by identifier — the catalog states what the agent can run, the flag
						// states what the user may pick.
						isUserSelectable: m.isUserSelectable ?? true,
						pricing: multiplierNumeric !== undefined ? `${multiplierNumeric}x` : undefined,
						multiplierNumeric,
						inputCost: pricing.inputCost,
						cacheCost: pricing.cacheCost,
						cacheWriteCost: pricing.cacheWriteCost,
						outputCost: pricing.outputCost,
						longContextInputCost: pricing.longContextInputCost,
						longContextCacheCost: pricing.longContextCacheCost,
						longContextCacheWriteCost: pricing.longContextCacheWriteCost,
						longContextOutputCost: pricing.longContextOutputCost,
						priceCategory: pricing.priceCategory,
						category: pricing.category,
						promo: pricing.promo,
						targetChatSessionType: this._sessionType,
						// Group agent-host models in the picker by their upstream provider
						// (Copilot CLI, OpenAI, a 3p BYOK provider, …). All of a host's
						// models share one vendor, so without this they'd render as a single
						// undifferentiated bucket. Presentation-only; routing stays by vendor.
						...(modelGroup ? { modelGroup } : {}),
						...(sourceModel ? { sourceModel } : {}),
						...(byokModelIdentifier !== undefined && { byokModelIdentifier }),
						...(byokModelHidden && { byokModelHidden }),
						capabilities: {
							vision: m.supportsVision ?? false,
							toolCalling: true,
							agentMode: true,
						},
						configurationSchema: this._toLanguageModelConfigurationSchema(m.configSchema),
					},
				};
			});
	}

	private _sourceModelFor(model: SessionModelInfo): ILanguageModelChatMetadata['sourceModel'] {
		const sourceId = readAgentModelSourceId(model);
		const visibility = this._visibilitySource;
		if (!visibility || sourceId !== visibility.sourceId) {
			return undefined;
		}
		return {
			sourceId,
			modelId: model.underlyingModelId ?? model.id,
			visibilityNamespace: visibility.namespace,
			visibilityOwner: visibility.owner,
		};
	}

	private _toLanguageModelConfigurationSchema(schema: ConfigSchema | undefined): ILanguageModelConfigurationSchema | undefined {
		if (!schema) {
			return undefined;
		}

		return {
			type: schema.type,
			required: schema.required,
			properties: Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => [key, {
				type: property.type,
				title: property.title,
				description: property.description,
				default: property.default,
				enum: property.enum,
				enumItemLabels: property.enumLabels,
				enumDescriptions: property.enumDescriptions,
				readOnly: property.readOnly,
				group: AgentHostLanguageModelProvider._groupForConfigKey(key),
			}])),
		};
	}

	private static _groupForConfigKey(key: string): string | undefined {
		switch (key) {
			case 'thinkingLevel': return 'navigation';
			case 'serviceTier': return 'performance';
			case 'contextSize': return 'tokens';
			default: return undefined;
		}
	}

	/**
	 * Derives the picker group id for a model — the vendor its models are bucketed
	 * under. A producer may pin the group id explicitly in `_meta` (e.g. Claude
	 * stamps its transport vendor — `copilot`/`anthropic` — there while keeping
	 * `provider` as the `claude` routing owner); that wins. Otherwise BYOK models
	 * are surfaced by the agent host under the `vendor/[group/]id` selection id (see
	 * `resolveByokSessionConfig`), so their upstream vendor is the id prefix; native
	 * harness models have no prefix and group under their `provider` (the harness,
	 * e.g. `copilotcli`). The picker resolves the display name from the vendor
	 * registry — no name mapping lives here.
	 */
	private _modelGroupFor(model: SessionModelInfo): ILanguageModelChatMetadata['modelGroup'] {
		const explicitGroupId = readAgentModelGroupId(model);
		const slash = model.id.indexOf('/');
		const groupVendorId = explicitGroupId ?? (slash > 0 ? model.id.slice(0, slash) : model.provider);
		if (!groupVendorId) {
			return undefined;
		}
		const sourceId = readAgentModelSourceId(model);
		return { id: groupVendorId, ...(sourceId !== undefined && { sourceId }) };
	}

	async sendChatRequest(): Promise<never> {
		throw new Error('Agent-host models do not support direct chat requests');
	}

	async provideTokenCount(): Promise<number> {
		return 0;
	}
}
