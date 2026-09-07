/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Serializable bridge contract between the node agent host (where the
 * {@link IByokLmProxyService} OpenAI-compatible proxy runs) and the renderer
 * (which owns the extension-provided BYOK language models via the LM API).
 *
 * These shapes are deliberately wire-friendly (plain JSON, no `VSBuffer`,
 * `URI`, or `workbench/contrib/chat` types) so they survive both the local
 * utility-process IPC channel and the remote JSON-RPC transport without a
 * translation step. The node side converts OpenAI Responses wire payloads
 * to/from these; the renderer side converts these to/from the VS Code
 * LM API (`ILanguageModelsService`).
 */

export interface IByokLmTextPart {
	readonly type: 'text';
	readonly text: string;
}

export type ByokLmImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';

export interface IByokLmImagePart {
	readonly type: 'image';
	readonly mimeType: ByokLmImageMimeType;
	readonly data: string;
}

export type IByokLmContentPart = IByokLmTextPart | IByokLmImagePart;

export interface IByokLmMessageItem {
	readonly type: 'message';
	readonly role: 'system' | 'developer' | 'user' | 'assistant';
	readonly content: IByokLmContentPart[];
}

export interface IByokLmReasoningItem {
	readonly type: 'reasoning';
	readonly id?: string;
	readonly summary: string[];
	readonly encryptedContent?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface IByokLmFunctionCallItem {
	readonly type: 'function_call';
	readonly callId: string;
	readonly name: string;
	readonly argumentsJson: string;
}

export interface IByokLmFunctionCallOutputItem {
	readonly type: 'function_call_output';
	readonly callId: string;
	readonly output: string;
}

export interface IByokLmCustomToolCallItem {
	readonly type: 'custom_tool_call';
	readonly callId: string;
	readonly name: string;
	readonly input: string;
}

export interface IByokLmCustomToolCallOutputItem {
	readonly type: 'custom_tool_call_output';
	readonly callId: string;
	readonly output: string;
}

export type IByokLmInputItem =
	IByokLmMessageItem |
	IByokLmReasoningItem |
	IByokLmFunctionCallItem |
	IByokLmFunctionCallOutputItem |
	IByokLmCustomToolCallItem |
	IByokLmCustomToolCallOutputItem;

export interface IByokLmFunctionTool {
	readonly type: 'function';
	readonly name: string;
	readonly description?: string;
	readonly parametersSchema?: object;
}

export interface IByokLmCustomTool {
	readonly type: 'custom';
	readonly name: string;
	readonly description?: string;
}

export type IByokLmTool = IByokLmFunctionTool | IByokLmCustomTool;

export interface IByokLmChatRequest {
	readonly vendor: string;
	readonly modelId: string;
	readonly instructions?: string;
	readonly input: IByokLmInputItem[];
	readonly tools?: IByokLmTool[];
	readonly previousResponseId?: string;
	readonly reasoningEffort?: string;
	readonly modelOptions?: Record<string, unknown>;
}

export interface IByokLmOutputMessageItem {
	readonly type: 'message';
	readonly content: IByokLmTextPart[];
}

export type IByokLmOutputItem =
	IByokLmOutputMessageItem |
	IByokLmReasoningItem |
	IByokLmFunctionCallItem |
	IByokLmCustomToolCallItem;

export interface IByokLmChatResult {
	readonly output: IByokLmOutputItem[];
	readonly responseId?: string;
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly reasoningTokens?: number;
	};
	readonly error?: string;
}

/**
 * Metadata for a renderer BYOK model, enumerated over the bridge so the node
 * agent host can advertise it to the SDK runtime without any host-side config.
 */
export interface IByokLmModelInfo {
	/** Provider/vendor name (the LM API vendor that registered the model). */
	readonly vendor: string;
	/** Provider-local model id. */
	readonly id: string;
	/** Display name, when the provider supplies one. */
	readonly name?: string;
	/**
	 * The identifier the model is registered under in the renderer's LM service —
	 * i.e. `toModelIdentifier(vendor, group, id)` in `extHostLanguageModels`
	 * (`<vendor>/<group>/<id>` when the user configured a provider group in
	 * `chatLanguageModels.json`, else `<vendor>/<id>`).
	 */
	readonly modelIdentifier?: string;
	/** Maximum context window tokens (prompt + output), when known. */
	readonly maxContextWindowTokens?: number;
	/** Maximum output tokens, when known. */
	readonly maxOutputTokens?: number;
	/** Whether the model accepts image inputs, when known. */
	readonly supportsVision?: boolean;
	/** Reasoning effort values advertised by the renderer model, when known. */
	readonly supportedReasoningEfforts?: readonly string[];
	/** Default reasoning effort advertised by the renderer model, when known. */
	readonly defaultReasoningEffort?: string;
	/** Harness ids the provider declares this model compatible with. */
	readonly supportedHarnesses?: readonly string[];
	/**
	 * Set when the serving renderer has this model hidden in "Manage Models".
	 * Hidden rows still cross the bridge: a client that reaches the catalog only
	 * through the host (the Agents window in a browser) has no other way to learn
	 * the row exists, and a page that omits it cannot show the user why. Nothing
	 * offers a hidden model for selection — see {@link visibleByokLmModels}.
	 */
	readonly hidden?: boolean;
}

/** A visible ChatGPT model owned by the serving window's configured Provider. */
export interface IManagedChatGptModelInfo {
	readonly id: string;
	readonly name: string;
	readonly maxContextWindowTokens?: number;
	readonly maxOutputTokens?: number;
	readonly supportsVision?: boolean;
	readonly supportedReasoningEfforts?: readonly string[];
	readonly defaultReasoningEffort?: string;
}

/**
 * The rows a model picker, a proxy `/models` listing or a harness session config
 * may offer, i.e. the catalog minus what the user hid in "Manage Models".
 * Callers that describe the catalog rather than offer from it — the harness model
 * lists published to clients — keep the hidden rows and carry the flag on.
 */
export function visibleByokLmModels(models: readonly IByokLmModelInfo[]): readonly IByokLmModelInfo[] {
	return models.filter(model => !model.hidden);
}

/** Resolved provider configuration for one renderer BYOK model. */
export interface IByokLmProviderConfiguration {
	readonly modelIdentifier: string;
	readonly vendor: string;
	readonly groupName: string;
	readonly modelId: string;
	readonly configuration: Record<string, unknown>;
}

/**
 * Returns the provider-local selection id used by the agent host. Configured
 * provider groups remain part of the id so models with the same vendor and
 * provider-local id do not collide.
 */
export function getByokLmSelectionModelId(model: IByokLmModelInfo): string {
	const vendorPrefix = `${model.vendor}/`;
	return model.modelIdentifier?.startsWith(vendorPrefix)
		? model.modelIdentifier.slice(vendorPrefix.length)
		: model.id;
}

/** Returns the provider-qualified model id advertised by the agent host. */
export function getByokLmAgentModelId(model: IByokLmModelInfo): string {
	return `${model.vendor}/${getByokLmSelectionModelId(model)}`;
}

/**
 * Split an id produced by {@link getByokLmAgentModelId} back into the vendor
 * (which selects the proxy route, `/v/<vendor>/…`) and the provider-local
 * selection id (which goes into the request body's `model`).
 *
 * The split is structural — first `/` wins — because a harness has to make this
 * call on a persisted {@link ModelSelection} whose model may no longer be in the
 * catalog. It is only sound because a BYOK id is the *only* model id a harness
 * advertises that carries a `/`: the subscription catalogs are bare slugs
 * (`claude-opus-4.6`, `gpt-5.6-sol`) and the per-session provider ids are
 * `@provider=`-prefixed with their halves url-encoded. Callers must therefore
 * peel off any `@provider=` qualification before asking.
 */
export function parseByokLmAgentModelId(agentModelId: string): { readonly vendor: string; readonly modelId: string } | undefined {
	const slash = agentModelId.indexOf('/');
	if (slash <= 0 || slash === agentModelId.length - 1) {
		return undefined;
	}
	return { vendor: agentModelId.slice(0, slash), modelId: agentModelId.slice(slash + 1) };
}

/** Resolves BYOK enablement and trace context from synchronized root configuration. */
export function resolveByokLmEnablement(rootConfigValue: boolean | undefined): { readonly enabled: boolean; readonly trace: string } {
	const enabled = rootConfigValue === true;
	return {
		enabled,
		trace: `enabled: ${enabled} (root config: ${rootConfigValue ?? 'unset'})`,
	};
}

export const IAgentHostByokLmHandler = createDecorator<IAgentHostByokLmHandler>('agentHostByokLmHandler');

/**
 * Renderer-side handler that services {@link IByokLmChatRequest}s by calling
 * the VS Code Language Model API. Implemented in the workbench (where
 * `ILanguageModelsService` lives) and reached from the node agent host over
 * the reverse bridge.
 */
export interface IAgentHostByokLmHandler {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the renderer's set of BYOK models changes, so the node agent
	 * host can re-enumerate them for the model picker. Optional: test fakes may
	 * omit it.
	 */
	readonly onDidChangeModels?: Event<void>;

	/**
	 * Run a BYOK Responses request against the extension-registered model that
	 * matches `request.vendor` + `request.modelId`. Rejects (or resolves with
	 * {@link IByokLmChatResult.error}) when no such model is available.
	 */
	chat(request: IByokLmChatRequest, token: CancellationToken): Promise<IByokLmChatResult>;

	/** Resolve the owning provider group for trusted native-harness routing. */
	resolveProviderConfiguration?(modelIdentifier: string, token: CancellationToken): Promise<IByokLmProviderConfiguration | undefined>;

	/**
	 * Enumerate the renderer's BYOK models (vendor `isBYOK`, excluding
	 * session-scoped agent-host copies) so the node agent host can synthesize
	 * provider/model config for the SDK runtime.
	 */
	listModels(token: CancellationToken): Promise<IByokLmModelInfo[]>;

	/** Subscription access is separate from BYOK routing and carries no credentials. */
	listChatGptModels?(token: CancellationToken): Promise<IManagedChatGptModelInfo[]>;
}

/**
 * Node-side connection to a single renderer's {@link IAgentHostByokLmHandler}.
 * Mirrors `IRemoteFilesystemConnection` for the reverse FS bridge. The renderer
 * pushes its models over {@link onDidChangeModels}; `chat` stays a round-trip.
 */
export interface IByokLmBridgeConnection {
	chat(request: IByokLmChatRequest): Promise<IByokLmChatResult>;
	resolveProviderConfiguration?(modelIdentifier: string): Promise<IByokLmProviderConfiguration | undefined>;
	/** Emits the renderer's current BYOK model snapshot on subscribe and on every change. */
	readonly onDidChangeModels: Event<IByokLmModelInfo[]>;
	/** Visible models in the configured ChatGPT Provider, including an authoritative empty list. */
	readonly onDidChangeChatGptModels?: Event<IManagedChatGptModelInfo[]>;
}
