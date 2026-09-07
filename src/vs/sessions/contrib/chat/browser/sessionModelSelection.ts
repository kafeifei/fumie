/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../base/common/map.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ChatInputModelSelectionController, IChatInputModelSelectionRuntime } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputModelSelectionController.js';
import { ChatModelSelectionDiagnostics } from '../../../../workbench/contrib/chat/browser/widget/input/chatModelSelectionDiagnostics.js';
import { getSelectedModelStorageKey, getStoredSelectedModel, storeSelectedModel } from '../../../../workbench/contrib/chat/common/chatSelectedModel.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ChatAgentLocation, ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService, isLanguageModelVisibleInPicker } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IntendedModelSlot } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { getRegisteredLanguageModels, IPendingModelSelection, isInConversationModelChoice, ModelSelectionReason, resolveConfiguredModel, resolveModelIdentifier, RestoredModelReason } from '../../../../workbench/contrib/chat/common/modelSelection.js';
import { isAgentHostProviderId } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ChatModelSource, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import { IActiveSession, IProviderSessionType, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { advertisedHarnessForModel, isClaudeHarnessId, mixOfficialSubscriptionModels, persistableModelOnHarness, resolveModelOnHarness } from './sessionModelHarness.js';
import { presentSessionPickerModel, presentSessionPickerModels } from './sessionModelPickerPresentation.js';
import { createModelSelectionState, EMPTY_MODEL_SELECTION_STATE, INormalizedSessionModelPickerOptions, ISessionModelSelectionState, normalizeModelPickerOptions } from './sessionModelPickerState.js';
import { IPickedSessionType, readPreferredSessionType } from './sessionTypePicker.js';

/** Bounded: a long-lived window binds arbitrarily many chats, and old ones are not worth the memory. */
const CONVERSATION_CACHE_SIZE = 50;

/**
 * Whether the chat owns this model. An absent source counts as owned, so a model the provider
 * merely failed to account for is not overwritten by `chat.defaultModel`.
 */
function isChatOwnModel(source: ChatModelSource | undefined): boolean {
	return source !== ChatModelSource.CarriedOver;
}

/** How the controller records a model the chat already has. */
export function restoreReasonForSource(source: ChatModelSource | undefined): RestoredModelReason {
	return isChatOwnModel(source)
		? ModelSelectionReason.RestoredChoice
		: ModelSelectionReason.SessionRestore;
}

/** How to report a decision the controller made. The same line, read the other way. */
function sourceForReason(reason: ModelSelectionReason | undefined): ChatModelSource {
	return isInConversationModelChoice(reason) ? ChatModelSource.Chosen : ChatModelSource.CarriedOver;
}

type ModelSelectionRefreshTrigger = 'sessionState' | 'configuration' | 'providers' | 'models';

function legacyModelPickerStorageKey(providerId: string, sessionType: string): string {
	return `sessions.modelPicker.${providerId}.${sessionType}.selectedModelId`;
}

/** Per conversation, not per input, so none of it can be read as another chat's answer. */
class ConversationModelSelection {
	/** The model this conversation is meant to run on, whatever the pool can offer right now. */
	readonly intent = new IntendedModelSlot();
	/** True once driven to a model the pool actually offers; a half-published pool does not count. */
	seeded = false;
}

export const ISessionModelSelection = createDecorator<ISessionModelSelection>('sessionModelSelection');

export interface ISessionModelSelection {
	readonly _serviceBrand: undefined;
	readonly state: IObservable<ISessionModelSelectionState>;
	readonly onDidRequestSessionType: Event<IPickedSessionType>;
	selectModel(modelIdentifier: string): boolean;
}

/**
 * Model selection for the Agents Window, on top of the shared
 * {@link ChatInputModelSelectionController}. Turns the active session and its provider into the
 * runtime the controller expects, and its decisions back into a provider write and picker state.
 * Precedence lives in the controller, so the two windows cannot drift on it.
 *
 * Mostly translation. What is left here is when a conversation counts as seeded, and when to wait
 * for an unpublished model rather than write a stand-in through to a backend.
 */
export class SessionModelSelection extends Disposable implements ISessionModelSelection {

	declare readonly _serviceBrand: undefined;

	private readonly _state = observableValue<ISessionModelSelectionState>(this, EMPTY_MODEL_SELECTION_STATE);
	readonly state: IObservable<ISessionModelSelectionState> = this._state;
	private readonly _onDidRequestSessionType = this._register(new Emitter<IPickedSessionType>());
	readonly onDidRequestSessionType = this._onDidRequestSessionType.event;

	private readonly _providerListener = this._register(new MutableDisposable());
	private readonly _diagnostics: ChatModelSelectionDiagnostics;
	private readonly _controller: ChatInputModelSelectionController;
	/**
	 * What this input knows about each conversation it has bound. The controller only ever reaches
	 * the bound conversation's record, so one chat's model selection cannot be applied to another.
	 */
	private readonly _conversations = new LRUCache<string, ConversationModelSelection>(CONVERSATION_CACHE_SIZE);
	private readonly _unboundConversation = new ConversationModelSelection();

	private _activeSession: IActiveSession | undefined;
	private _activeProvider: ISessionsProvider | undefined;
	private _listenedProvider: ISessionsProvider | undefined;
	private _models: readonly ILanguageModelChatMetadataAndIdentifier[] = [];
	private _modelTarget: string | undefined;
	private _boundSessionKey: string | undefined;
	private _boundConversationKey: string | undefined;
	/** Read from the chat, not the session: session status aggregates across peer chats. */
	private _chatIsEmpty = false;
	/** The conversation's own model is unknown but presumed to exist: show a selection, never write it. */
	private _displayOnly = false;
	/** A model pick waiting for the new-session composer to replace the draft with its owning harness. */
	private _pendingHarness: { readonly model: ILanguageModelChatMetadataAndIdentifier; readonly pick: IPickedSessionType } | undefined;

	constructor(
		private readonly _session: IObservable<IActiveSession | undefined>,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@ILanguageModelsService private readonly _languageModelsService?: ILanguageModelsService,
		@ISessionsManagementService private readonly _sessionsManagementService?: ISessionsManagementService,
		@IChatSessionsService private readonly _chatSessionsService?: IChatSessionsService,
	) {
		super();
		this._diagnostics = new ChatModelSelectionDiagnostics(logService, this._storageService, () => {
			const session = this._session.get();
			return {
				surface: 'sessions',
				location: ChatAgentLocation.Chat,
				modelTarget: this._modelTarget,
				sessionKey: session?.sessionId,
				conversationKey: session?.activeChat.get().resource.toString(),
				metadata: {
					providerId: session?.providerId,
					sessionType: session?.sessionType,
					sessionId: session?.sessionId,
				},
			};
		});
		this._controller = this._register(new ChatInputModelSelectionController(this._createRuntime(), this._diagnostics));
		this._register(autorun(reader => {
			const session = this._session.read(reader);
			session?.modelId.read(reader);
			session?.status.read(reader);
			const chat = session?.activeChat.read(reader);
			chat?.status.read(reader);
			// Where the model came from is what decides whether it outranks `chat.defaultModel`.
			chat?.modelSource.read(reader);
			this._refresh('sessionState', session);
		}));
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.DefaultModel)) {
				this._refresh('configuration');
			}
		}));
		this._register(this._sessionsProvidersService.onDidChangeProviders(() => this._refresh('providers')));
		if (this._sessionsManagementService) {
			this._register(this._sessionsManagementService.onDidChangeSessionTypes(() => this._refresh('providers')));
		}
		if (this._languageModelsService) {
			this._register(this._languageModelsService.onDidChangeModelVisibility(() => this._refresh('models')));
			// With no session there is no provider relaying its pool, so the catalog is watched
			// directly for the default agent's models. A session's own pool already arrives
			// through `ISessionsProvider.onDidChangeModels`.
			this._register(this._languageModelsService.onDidChangeLanguageModels(() => {
				if (!this._session.get()) {
					this._refresh('models');
				}
			}));
		}
		this._register(this._storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(event => {
			this._diagnostics.logStorageChange(event, this._state.get().currentModel?.identifier);
		}));
	}

	selectModel(modelIdentifier: string): boolean {
		const session = this._session.get();
		const provider = session ? this._sessionsProvidersService.getProvider(session.providerId) : undefined;
		if (!session || !provider) {
			return this._selectDefaultAgentModel(modelIdentifier, !session ? 'noSession' : 'noProvider');
		}

		// Fresh snapshot: the pool the picker rendered from may already be stale.
		const snapshot = provider.getModelsSnapshot(session.sessionId);
		this._modelTarget = snapshot.modelTarget;
		this._models = presentSessionPickerModels(this._catalogModelsForPicker(session.sessionType, this._chatSessionType(session), snapshot.models));
		const model = this._models.find(model => model.identifier === modelIdentifier);
		if (!model) {
			this._diagnostics.report('selection-rejected', {
				requestedModel: modelIdentifier,
				reason: 'modelUnavailable',
				availableModels: this._models.map(model => model.identifier).join(','),
			}, 'info');
			return false;
		}

		const requestedHarness = this._requestedHarness(session, model);
		if (requestedHarness) {
			this._pendingHarness = { model, pick: requestedHarness };
			this._diagnostics.report('explicit-selection', {
				model: model.identifier,
				requestedSessionType: requestedHarness.sessionTypeId,
			}, 'info');
			this._onDidRequestSessionType.fire(requestedHarness);
			return true;
		}

		const persistModel = this._presentedModel(
			persistableModelOnHarness(model, snapshot.models, session.sessionType, this._chatSessionType(session)),
			this._models,
		);

		const options = normalizeModelPickerOptions(provider.getModelPickerOptions(session.sessionId));
		const providerModelBefore = session.modelId.get();
		const storageKey = getSelectedModelStorageKey(ChatAgentLocation.Chat, snapshot.modelTarget);
		const conversation = this._conversation();
		try {
			this._controller.applySelection(persistModel, () => {
				provider.setModel(session.sessionId, session.activeChat.get().resource, persistModel.identifier, ChatModelSource.Chosen);
				storeSelectedModel(this._storageService, ChatAgentLocation.Chat, snapshot.modelTarget, persistModel.identifier);
			}, true, true);
		} catch (error) {
			this._diagnostics.report('provider-selection-failed', {
				requestedModel: modelIdentifier,
				providerModelBefore,
				providerModelAfter: session.modelId.get(),
				storedModelAfter: this._storageService.get(storageKey, StorageScope.PROFILE),
				error: String(error),
			}, 'error');
			throw error;
		}
		conversation.seeded = true;
		this._publish(options, undefined);
		this._diagnostics.report('provider-selection-applied', {
			requestedModel: persistModel.identifier,
			providerModelBefore,
			providerModelAfter: session.modelId.get(),
			storedModelAfter: this._storageService.get(storageKey, StorageScope.PROFILE),
		}, 'info');
		return true;
	}

	private _createRuntime(): IChatInputModelSelectionRuntime {
		return {
			// The pool's target, not the session type: it is what the provider scopes models by.
			getCurrentSessionType: () => this._modelTarget,
			isEmpty: () => this._chatIsEmpty,
			getModels: () => [...this._models],
			getAllModels: () => [...this._models],
			getConfiguredModelValue: () => this._configurationService.getValue<string>(ChatConfiguration.DefaultModel),
			// A session runs whatever its provider published: no mode, nowhere else to show it.
			isModelSupportedHere: () => true,
			getDeclaredDefaultModel: models => models.find(model => model.metadata.isDefaultForLocation[ChatAgentLocation.Chat]),
			getBoundConversationKey: () => this._boundConversationKey,
			getIntentHolder: () => this._conversation().intent,
			applyModel: model => this._pushModelToProvider(model),
			// The optional members are absent on purpose: the snapshot is already the session's pool,
			// `_refresh` owns refreshing, and sessions have no per-model configuration.
		};
	}

	/** Unreachable while another chat is bound, so one chat's selection cannot reach another. */
	private _conversation(): ConversationModelSelection {
		const conversationKey = this._boundConversationKey;
		if (!conversationKey) {
			return this._unboundConversation;
		}
		let conversation = this._conversations.get(conversationKey);
		if (!conversation) {
			conversation = new ConversationModelSelection();
			this._conversations.set(conversationKey, conversation);
		}
		return conversation;
	}

	private _refresh(trigger: ModelSelectionRefreshTrigger, session = this._session.get()): void {
		const provider = session ? this._sessionsProvidersService.getProvider(session.providerId) : undefined;
		this._setProvider(provider);
		this._activeSession = session;
		this._activeProvider = provider;

		if (!session || !provider) {
			this._boundSessionKey = undefined;
			this._boundConversationKey = undefined;
			this._chatIsEmpty = false;
			this._displayOnly = false;
			// Nothing to clear: each conversation's state lives in its own record.
			this._publishDefaultAgentPool();
			return;
		}

		const conversationKey = session.activeChat.get().resource.toString();
		// Scoped to the active chat: peer chats in one session each keep their own model.
		const chat = session.activeChat.get();
		const chatModelId = session.modelId.get();
		// A model the provider cannot account for is read as the chat's own.
		const chatModelSource = chatModelId ? (chat.modelSource.get() ?? ChatModelSource.Chosen) : undefined;
		// Undefined only when the chat has no model, which is the one case with no authority at all.
		const chatModelReason = chatModelSource === undefined ? undefined : restoreReasonForSource(chatModelSource);
		const baseSnapshot = provider.getModelsSnapshot(session.sessionId, chatModelId);
		const remembered = this._getRememberedModel(session, baseSnapshot.modelTarget);

		const rebound = session.sessionId !== this._boundSessionKey || conversationKey !== this._boundConversationKey;
		// A chat's own model always outranks the remembered preference, which only seeds a chat
		// that has yet to run on anything. Reading it per chat is what keeps one chat's choice out
		// of another's: the incoming chat brings its own model with it.
		const desiredModelId = chatModelId ?? remembered;
		const snapshot = desiredModelId === chatModelId ? baseSnapshot : provider.getModelsSnapshot(session.sessionId, desiredModelId);

		const catalogModels = this._catalogModelsForPicker(session.sessionType, this._chatSessionType(session), snapshot.models);
		this._models = presentSessionPickerModels(catalogModels);
		this._modelTarget = snapshot.modelTarget;
		const options = normalizeModelPickerOptions(provider.getModelPickerOptions(session.sessionId));
		const catalogDesiredModelResolution = catalogModels === snapshot.models
			? undefined
			: resolveModelIdentifier(this._models, desiredModelId, true);
		// A mixed-in subscription row can satisfy a desired id the provider does not publish itself.
		// Otherwise retain the provider's pending/alias answer so the shared controller keeps its
		// upstream late-publication semantics.
		const desiredModelResolution = catalogDesiredModelResolution?.kind === 'available'
			? catalogDesiredModelResolution
			: snapshot.desiredModelResolution;
		// The provider resolves the desired model: a host republishes it under its own identifier,
		// so matching the raw one would miss it.
		const resolvedDesiredModel = desiredModelResolution.kind === 'available'
			? this._presentedModel(desiredModelResolution.model, this._models)
			: undefined;

		// Bind first, so whatever the controller intends is recorded against this conversation.
		this._boundSessionKey = session.sessionId;
		this._boundConversationKey = conversationKey;
		this._chatIsEmpty = chat.status.get() === SessionStatus.Untitled;
		// A conversation that has run has a model of its own, even if the provider has not said what
		// it is. Show a stand-in, never write one: the write would change what it runs on.
		this._displayOnly = !chatModelId && !this._chatIsEmpty;
		if (rebound) {
			// Unconditional: what spoke for the previous conversation must not outlive it.
			this._controller.beginConversationSwitch();
		}
		if (this._applyPendingHarness(session, provider, snapshot.models)) {
			this._publish(options, undefined);
			return;
		}

		// Removing or hiding the canonical provider withdraws its projections from
		// every picker immediately, but it must not rewrite a conversation that is
		// already running one of those models. Keep the controller's intent on the
		// registered projection and withhold provider writes until its owner returns.
		const unavailableSourceModel = chatModelId ? this._unavailableManagedSourceModel(chatModelId) : undefined;
		if (unavailableSourceModel) {
			this._displayOnly = true;
			const conversation = this._conversation();
			if (rebound || this._conversationSelectionChanged(unavailableSourceModel, chatModelSource)) {
				this._claimChatModel(unavailableSourceModel, chatModelSource, conversationKey);
			}
			conversation.seeded = true;
			this._diagnostics.report('managed-projection-unavailable', {
				trigger,
				model: unavailableSourceModel.identifier,
			}, 'info');
			this._publish(options, undefined);
			return;
		}

		// Only a conversation that could be written to has anything to wait for. A display-only one
		// writes nothing either way (see `_pushModelToProvider`), so waiting would blank its picker
		// and block its composer to prevent a write that was never going to happen.
		if (desiredModelResolution.kind === 'pending'
			&& !this._displayOnly
			&& !this._controller.configuredDefaultToSeed(chatModelReason)) {
			// Wait rather than push a stand-in through to the backend; re-seed once the pool settles.
			this._conversation().seeded = false;
			this._diagnostics.report('await-desired-model', {
				trigger,
				desiredModel: desiredModelResolution.identifier,
				availableModels: this._models.map(model => model.identifier).join(','),
			}, 'info');
			this._publish(options, { reference: desiredModelResolution.identifier });
			return;
		}

		try {
			this._drive(rebound, chatModelId, chatModelSource, remembered, resolvedDesiredModel, conversationKey);
		} catch (error) {
			// The provider refused the write. Retry on the next refresh, and show what it actually has.
			this._conversation().seeded = false;
			this._publish(options, undefined, this._models.find(model => model.identifier === session.modelId.get()));
			return;
		}
		this._publish(options, undefined);
	}

	/**
	 * Hands the session's state to the controller through the same entry points Workbench chat
	 * uses: seed a newly bound conversation, follow the conversation's own model when it changes
	 * underneath us, and reconcile against the pool that was just published.
	 */
	private _drive(
		rebound: boolean,
		chatModelId: string | undefined,
		chatModelSource: ChatModelSource | undefined,
		rememberedModelId: string | undefined,
		resolvedDesiredModel: ILanguageModelChatMetadataAndIdentifier | undefined,
		conversationKey: string,
	): void {
		// The provider's answer for whatever was asked about: the chat's model, else the preference.
		const chatModel = chatModelId
			? (resolvedDesiredModel ?? this._models.find(model => model.identifier === chatModelId))
			: undefined;
		const rememberedId = chatModelId ? rememberedModelId : (resolvedDesiredModel?.identifier ?? rememberedModelId);
		const conversation = this._conversation();
		if (rebound || !conversation.seeded) {
			// Set first: a provider echo can synchronously re-enter here, and must see seeding started.
			conversation.seeded = true;
			if (chatModel) {
				// A model the chat already runs on outranks `chat.defaultModel`.
				this._claimChatModel(chatModel, chatModelSource, conversationKey);
			} else {
				this._controller.initialize(rememberedId);
			}
			// Only counts once the pool actually offers what was selected.
			conversation.seeded = this._isShowingSelectableModel();
		} else if (chatModel && this._conversationSelectionChanged(chatModel, chatModelSource)) {
			// It moved without this input asking, so adopt it. A peer promoting our automatic pick to
			// their own choice counts, even on the same model.
			this._claimChatModel(chatModel, chatModelSource, conversationKey);
		}
		this._controller.reconcileModelListChange(this._models);
		conversation.seeded ||= this._isShowingSelectableModel();
	}

	/** Whether the controller is on a model this session's pool actually offers. */
	private _isShowingSelectableModel(): boolean {
		const current = this._controller.currentModel.get();
		return !!current && this._models.some(model => model.identifier === current.identifier);
	}

	/**
	 * Whether the chat's model, or whether it counts as the chat's own, differs from what we hold.
	 * Our own echo matches on both, since the source came from the reason we still hold.
	 */
	private _conversationSelectionChanged(
		chatModel: ILanguageModelChatMetadataAndIdentifier,
		source: ChatModelSource | undefined,
	): boolean {
		return chatModel.identifier !== this._controller.currentModel.get()?.identifier
			|| isChatOwnModel(source) !== isInConversationModelChoice(this._controller.selectionReason);
	}

	/** Adopts the model the chat is on, telling the controller whether it counts as a choice. */
	private _claimChatModel(
		chatModel: ILanguageModelChatMetadataAndIdentifier,
		source: ChatModelSource | undefined,
		conversationKey: string,
	): void {
		this._controller.syncFromConversationState(
			chatModel,
			undefined,
			this._modelTarget,
			conversationKey,
			false,
			restoreReasonForSource(source),
		);
	}

	private _pushModelToProvider(model: ILanguageModelChatMetadataAndIdentifier): void {
		const session = this._activeSession;
		const provider = this._activeProvider;
		if (!session || !provider) {
			return;
		}
		if (this._displayOnly) {
			this._diagnostics.report('provider-write-withheld', {
				model: model.identifier,
				reason: this._controller.selectionReason,
			}, 'info');
			return;
		}
		const providerModelBefore = session.modelId.get();
		if (providerModelBefore === model.identifier) {
			// Already what it runs on. Re-pushing round-trips a no-op, and claiming it would mask a
			// choice made elsewhere.
			return;
		}
		// The controller records the reason before handing over, so this is the reason for this write.
		const source = sourceForReason(this._controller.selectionReason);
		try {
			provider.setModel(session.sessionId, session.activeChat.get().resource, model.identifier, source);
		} catch (error) {
			this._diagnostics.report('provider-automatic-selection-failed', {
				model: model.identifier,
				reason: this._controller.selectionReason,
				providerModelBefore,
				providerModelAfter: session.modelId.get(),
				error: String(error),
			}, 'error');
			throw error;
		}
		this._diagnostics.report('provider-automatic-selection-applied', {
			model: model.identifier,
			reason: this._controller.selectionReason,
			providerModelBefore,
			providerModelAfter: session.modelId.get(),
		}, 'info');
	}

	private _publish(
		options: INormalizedSessionModelPickerOptions,
		pendingSelection: IPendingModelSelection | undefined,
		currentModel = this._controller.currentModel.get(),
	): void {
		this._state.set(createModelSelectionState(this._models, options, currentModel, pendingSelection), undefined);
	}

	/** Applies a model picked on the previous draft once its owning harness has replaced that draft. */
	private _applyPendingHarness(
		session: IActiveSession,
		provider: ISessionsProvider,
		providerModels: readonly ILanguageModelChatMetadataAndIdentifier[],
	): boolean {
		const pending = this._pendingHarness;
		if (!pending || !this._pendingHarnessMatches(session, pending.pick)) {
			return false;
		}

		const resolved = resolveModelOnHarness(pending.model, providerModels);
		const persistModel = persistableModelOnHarness(
			resolved ?? pending.model,
			providerModels,
			session.sessionType,
			this._chatSessionType(session),
		);
		if (!resolved && persistModel.identifier === pending.model.identifier) {
			// An empty pool may still publish the mapped model. A resolved non-empty pool is final.
			if (providerModels.length > 0) {
				this._pendingHarness = undefined;
			}
			return false;
		}

		this._pendingHarness = undefined;
		const presentedModel = this._presentedModel(persistModel, this._models);
		const providerModelBefore = session.modelId.get();
		const conversation = this._conversation();
		this._controller.applySelection(presentedModel, () => {
			provider.setModel(session.sessionId, session.activeChat.get().resource, persistModel.identifier, ChatModelSource.Chosen);
			storeSelectedModel(this._storageService, ChatAgentLocation.Chat, this._modelTarget, persistModel.identifier);
		}, true, true);
		conversation.seeded = true;
		this._diagnostics.report('provider-selection-applied', {
			requestedModel: pending.model.identifier,
			resolvedModel: persistModel.identifier,
			providerModelBefore,
			providerModelAfter: session.modelId.get(),
		}, 'info');
		return true;
	}

	private _chatSessionType(session: IActiveSession): string | undefined {
		const advertised = this._offeredTypes(session).find(type =>
			type.providerId === session.providerId && type.sessionType.id === session.sessionType);
		if (advertised?.sessionType.chatSessionType) {
			return advertised.sessionType.chatSessionType;
		}
		const scheme = session.resource?.scheme;
		return scheme && /claude|kimi/i.test(scheme) ? scheme : undefined;
	}

	/** Harness rows plus visible compatible official subscription rows, with picker-only presentation. */
	private _catalogModelsForPicker(
		sessionTypeId: string,
		chatSessionType: string | undefined,
		sessionModels: readonly ILanguageModelChatMetadataAndIdentifier[],
	): readonly ILanguageModelChatMetadataAndIdentifier[] {
		const languageModelsService = this._languageModelsService;
		if (!languageModelsService) {
			return sessionModels;
		}
		return mixOfficialSubscriptionModels(
			sessionTypeId,
			sessionModels,
			this._visibleRegisteredModels(languageModelsService),
			chatSessionType,
		);
	}

	private _visibleRegisteredModels(languageModelsService: ILanguageModelsService): readonly ILanguageModelChatMetadataAndIdentifier[] {
		const allModels = getRegisteredLanguageModels(languageModelsService);
		return allModels.filter(model =>
			model.metadata.isUserSelectable !== false
			&& isLanguageModelVisibleInPicker(model, allModels, identifier => languageModelsService.isModelHidden(identifier))
		);
	}

	private _unavailableManagedSourceModel(modelIdentifier: string): ILanguageModelChatMetadataAndIdentifier | undefined {
		const languageModelsService = this._languageModelsService;
		if (!languageModelsService) {
			return undefined;
		}
		const allModels = getRegisteredLanguageModels(languageModelsService);
		const exact = allModels.find(model => model.identifier === modelIdentifier);
		const aliases = exact ? [] : allModels.filter(model =>
			model.metadata.targetChatSessionType === this._modelTarget
			&& (model.metadata.id === modelIdentifier || model.metadata.underlyingModelId === modelIdentifier));
		const held = this._controller.currentModel.get();
		const heldMatches = held && (held.identifier === modelIdentifier
			|| held.metadata.id === modelIdentifier
			|| held.metadata.underlyingModelId === modelIdentifier)
			? held
			: undefined;
		const model = exact ?? (aliases.length === 1 ? aliases[0] : undefined) ?? heldMatches;
		if (!model?.metadata.sourceModel || this._models.some(candidate => candidate.identifier === model.identifier)) {
			return undefined;
		}
		return model;
	}

	/**
	 * What the picker shows before any session exists. There is nothing for a provider to scope a
	 * snapshot by, but the agent a new session would start on is already known — Settings names the
	 * same one — so the picker can name the model that session would run on instead of showing
	 * nothing. When no agent advertises a pool the state stays empty, and
	 * {@link ISessionModelSelectionState.poolResolved} false with it, so the shared widget cannot
	 * read the empty list as Copilot needing sign-in.
	 */
	private _publishDefaultAgentPool(): void {
		const type = this._defaultAgentType();
		const modelTarget = type ? type.sessionType.chatSessionType ?? type.sessionType.id : undefined;
		const models = type && modelTarget ? this._defaultAgentModels(type, modelTarget) : [];
		this._models = models;
		this._modelTarget = models.length > 0 ? modelTarget : undefined;
		if (models.length === 0 || !modelTarget) {
			this._state.set(EMPTY_MODEL_SELECTION_STATE, undefined);
			return;
		}
		const options: INormalizedSessionModelPickerOptions = {
			...normalizeModelPickerOptions(undefined),
			// Presentation is the provider's to state and there is no session to ask it about.
			// Only Auto is worth resolving here: offering it on a harness that requires an explicit
			// model would remember a model that harness cannot run.
			showAutoModel: this._chatSessionsService?.supportsAutoModelForSessionType(modelTarget) ?? true,
		};
		this._state.set(createModelSelectionState(models, options, this._defaultAgentModel(models), undefined), undefined);
	}

	/**
	 * The agent a new session would start on: the remembered pick while it is still advertised,
	 * else the first advertised agent host. Read from every provider's types rather than a folder's,
	 * so it answers before a workspace has been picked.
	 */
	private _defaultAgentType(): IProviderSessionType | undefined {
		const types = this._sessionsManagementService?.getAllProviderSessionTypes() ?? [];
		const preferred = readPreferredSessionType(this._storageService);
		const remembered = preferred && types.find(type => type.sessionType.id === preferred.sessionTypeId
			&& (preferred.providerId === undefined || type.providerId === preferred.providerId));
		// Unremembered falls to the first agent host, the same one Settings names as the default
		// agent: an agent host is what advertises the `chatSessionType` its models are registered
		// against, so it is the only kind whose pool can be found without a session to ask.
		return remembered || types.find(type => isAgentHostProviderId(type.providerId));
	}

	/** That agent's pool, read straight from the catalog: its models are registered against its target. */
	private _defaultAgentModels(
		type: IProviderSessionType,
		modelTarget: string,
	): readonly ILanguageModelChatMetadataAndIdentifier[] {
		const languageModelsService = this._languageModelsService;
		if (!languageModelsService) {
			return [];
		}
		const targeted = this._visibleRegisteredModels(languageModelsService)
			.filter(model => model.metadata.targetChatSessionType === modelTarget);
		return presentSessionPickerModels(
			this._catalogModelsForPicker(type.sessionType.id, type.sessionType.chatSessionType, targeted));
	}

	/**
	 * The model that agent would start on, by the precedence
	 * {@link ChatInputModelSelectionController.initialize} applies to a conversation with no
	 * history: `chat.defaultModel`, then the remembered preference, then the pool's own default.
	 */
	private _defaultAgentModel(
		models: readonly ILanguageModelChatMetadataAndIdentifier[],
	): ILanguageModelChatMetadataAndIdentifier | undefined {
		const configured = resolveConfiguredModel(this._configurationService.getValue<string>(ChatConfiguration.DefaultModel), models);
		const remembered = getStoredSelectedModel(this._storageService, ChatAgentLocation.Chat, this._modelTarget);
		return configured
			?? models.find(model => model.identifier === remembered)
			?? models.find(model => model.metadata.isDefaultForLocation[ChatAgentLocation.Chat])
			?? models[0];
	}

	/**
	 * A pick made before a session exists. There is no chat to write it to, so it is only
	 * remembered for that agent's pool — which is what seeds the session once it is created.
	 */
	private _selectDefaultAgentModel(modelIdentifier: string, reason: string): boolean {
		const modelTarget = this._modelTarget;
		if (!modelTarget || !this._models.some(model => model.identifier === modelIdentifier)) {
			this._diagnostics.report('selection-rejected', {
				requestedModel: modelIdentifier,
				reason,
			}, 'info');
			return false;
		}
		storeSelectedModel(this._storageService, ChatAgentLocation.Chat, modelTarget, modelIdentifier);
		this._publishDefaultAgentPool();
		return true;
	}

	private _presentedModel(
		model: ILanguageModelChatMetadataAndIdentifier,
		pickerModels: readonly ILanguageModelChatMetadataAndIdentifier[],
	): ILanguageModelChatMetadataAndIdentifier {
		return pickerModels.find(candidate => candidate.identifier === model.identifier)
			?? presentSessionPickerModel(model);
	}

	private _offeredTypes(session: IActiveSession): readonly IProviderSessionType[] {
		if (!this._sessionsManagementService) {
			return [];
		}
		if (session.isQuickChat?.get() ?? false) {
			return this._sessionsManagementService.getQuickChatSessionTypes();
		}
		const folderUri = session.workspace?.get()?.folders[0]?.root;
		return folderUri ? this._sessionsManagementService.getSessionTypesForFolder(folderUri) : [];
	}

	private _requestedHarness(
		session: IActiveSession,
		model: ILanguageModelChatMetadataAndIdentifier,
	): IPickedSessionType | undefined {
		if (session.status.get() !== SessionStatus.Untitled || !this._sessionsManagementService) {
			return undefined;
		}
		const harness = advertisedHarnessForModel(model, this._offeredTypes(session));
		if (!harness || (harness.providerId === session.providerId && harness.sessionTypeId === session.sessionType)) {
			return undefined;
		}
		// Configured provider rows intentionally stay on Claude Code even when their family resembles another harness.
		if (isClaudeHarnessId(session.sessionType, this._chatSessionType(session))) {
			return undefined;
		}
		return harness;
	}

	private _pendingHarnessMatches(session: IActiveSession, pick: IPickedSessionType): boolean {
		return session.providerId === pick.providerId && session.sessionType === pick.sessionTypeId;
	}

	/** The remembered preference, migrating the legacy key forward the first time it is seen. */
	private _getRememberedModel(session: IActiveSession, modelTarget: string | undefined): string | undefined {
		const storedSelection = getStoredSelectedModel(this._storageService, ChatAgentLocation.Chat, modelTarget);
		if (storedSelection) {
			return storedSelection;
		}

		const legacyStorageKey = legacyModelPickerStorageKey(session.providerId, session.sessionType);
		const legacyIdentifier = this._storageService.get(legacyStorageKey, StorageScope.PROFILE);
		if (legacyIdentifier) {
			storeSelectedModel(this._storageService, ChatAgentLocation.Chat, modelTarget, legacyIdentifier);
			this._diagnostics.report('legacy-selection-migrated', {
				legacyStorageKey,
				model: legacyIdentifier,
			}, 'info');
			return legacyIdentifier;
		}
		return undefined;
	}

	private _setProvider(provider: ISessionsProvider | undefined): void {
		if (this._listenedProvider === provider) {
			return;
		}
		this._listenedProvider = provider;
		this._providerListener.value = provider?.onDidChangeModels(() => this._refresh('models'));
	}
}
