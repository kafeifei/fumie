/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IByokLmBridgeConnection, IByokLmModelInfo, IByokLmProviderConfiguration } from '../common/agentHostByokLm.js';

export const IByokLmBridgeRegistry = createDecorator<IByokLmBridgeRegistry>('byokLmBridgeRegistry');

/**
 * Node-side registry of renderer {@link IByokLmBridgeConnection}s keyed by
 * client id. Populated by the agent host's connection lifecycle (one entry per
 * connected renderer) and consumed by {@link IByokLmProxyService} (inference
 * routing) and {@link CopilotAgent} (model catalogue).
 *
 * **Single serving window, multiple connections.** BYOK is serviced by the
 * renderer LM API, whose BYOK models are a property of the user's installed
 * extensions, not of a particular window — so every window that registers the
 * handler exposes the same set. Both the main workbench and the dedicated Agents
 * app register it (each runs a full extension host whose LM API holds the same
 * BYOK models), so either can serve. A connection that connects without binding
 * the handler never pushes a snapshot and is treated as non-serving. The registry
 * therefore does NOT aggregate per-window model sets; it surfaces the models from
 * any one *serving* window (preferring one that actually has models) and routes
 * inference there, automatically excluding non-serving windows.
 *
 * **Push, not pull.** Each connection pushes its current model snapshot over
 * {@link IByokLmBridgeConnection.onDidChangeModels} (on subscribe and on every
 * change); the registry subscribes on {@link register}, caches each snapshot, and
 * fires {@link onDidChangeModels} when the serving model set changes. A connection
 * becomes "serving" once it pushes its first snapshot (even an empty one).
 */
export interface IByokLmBridgeRegistry {
	readonly _serviceBrand: undefined;

	/** Register a renderer connection. Disposing the result removes it. */
	register(clientId: string, connection: IByokLmBridgeConnection): IDisposable;

	/**
	 * The serving window's BYOK models, read synchronously from the cache (no
	 * enumeration). Use this for fast reads driven by {@link onDidChangeModels}.
	 *
	 * The snapshot is the whole catalog, including rows the window has hidden in
	 * "Manage Models" (flagged {@link IByokLmModelInfo.hidden}). Anything that
	 * offers models for selection must narrow it with {@link visibleByokLmModels}.
	 */
	getModels(): readonly IByokLmModelInfo[];

	/**
	 * A connection that can serve BYOK inference, or `undefined` when none can.
	 * All serving windows expose the same models, so any one is a valid target.
	 */
	getServingConnection(): IByokLmBridgeConnection | undefined;

	/** Resolve the provider configuration for a renderer model identifier. */
	resolveProviderConfiguration?(modelIdentifier: string): Promise<IByokLmProviderConfiguration | undefined>;

	/** Resolves once any renderer publishes a non-empty provider catalog. */
	readonly whenModelsAvailable?: Promise<void>;

	/** Resolves once any renderer publishes its first authoritative snapshot, including an empty one. */
	readonly whenInitialSnapshot?: Promise<void>;

	/** Resolves when the named renderer connection publishes its first authoritative snapshot. */
	waitForInitialSnapshot?(clientId: string): Promise<void> | undefined;

	/**
	 * Subscribe to changes in the set of registered connections (a renderer
	 * connecting or disconnecting) or in the serving window's pushed models, so
	 * consumers can re-read {@link getModels}. Disposing the result removes the
	 * listener.
	 */
	onDidChangeModels(listener: () => void): IDisposable;
}

/**
 * Per-connection registry entry. `models` is `undefined` until the connection
 * pushes its first snapshot; a connection with defined `models` is "serving"
 * (it pushed, even an empty list). Non-serving windows (those that did not
 * register the BYOK handler and therefore never push) keep `models === undefined`.
 */
interface IConnectionEntry {
	readonly connection: IByokLmBridgeConnection;
	models: readonly IByokLmModelInfo[] | undefined;
	readonly initialSnapshot: DeferredPromise<void>;
	readonly store: DisposableStore;
}

export class ByokLmBridgeRegistry implements IByokLmBridgeRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<string, IConnectionEntry>();
	private readonly _pendingInitialSnapshots = new Map<string, DeferredPromise<void>>();
	private readonly _changeListeners = new Set<() => void>();
	private readonly _modelsAvailable = new DeferredPromise<void>();
	private readonly _initialSnapshot = new DeferredPromise<void>();
	readonly whenModelsAvailable = this._modelsAvailable.p;
	readonly whenInitialSnapshot = this._initialSnapshot.p;

	onDidChangeModels(listener: () => void): IDisposable {
		this._changeListeners.add(listener);
		return toDisposable(() => {
			this._changeListeners.delete(listener);
		});
	}

	private _notifyChanged(): void {
		// Snapshot first: a listener may unsubscribe (mutating the set) while it
		// is being notified.
		for (const listener of [...this._changeListeners]) {
			listener();
		}
	}

	register(clientId: string, connection: IByokLmBridgeConnection): IDisposable {
		// Replace any prior entry for the same client id (e.g. a reconnect).
		this._entries.get(clientId)?.store.dispose();

		const store = new DisposableStore();
		const initialSnapshot = this._pendingInitialSnapshots.get(clientId) ?? new DeferredPromise<void>();
		this._pendingInitialSnapshots.delete(clientId);
		const entry: IConnectionEntry = { connection, models: undefined, initialSnapshot, store };
		this._entries.set(clientId, entry);

		// Cache each pushed snapshot; notify only when the serving set changes.
		store.add(connection.onDidChangeModels(models => {
			// Drop the push if the entry was removed/replaced meanwhile.
			if (this._entries.get(clientId) !== entry) {
				return;
			}
			const previousModels = entry.models;
			const isInitialSnapshot = previousModels === undefined;
			if (previousModels === undefined || !modelsEqual(previousModels, models)) {
				entry.models = models;
				this._notifyChanged();
				if (isInitialSnapshot && !this._initialSnapshot.isSettled) {
					this._initialSnapshot.complete();
				}
				if (isInitialSnapshot && !entry.initialSnapshot.isSettled) {
					entry.initialSnapshot.complete();
				}
				if (models.length > 0 && !this._modelsAvailable.isSettled) {
					this._modelsAvailable.complete();
				}
			}
		}));

		// The connection set changed (a renderer connected).
		this._notifyChanged();

		return toDisposable(() => {
			if (this._entries.get(clientId) === entry) {
				this._entries.delete(clientId);
				entry.store.dispose();
				this._notifyChanged();
			}
		});
	}

	getModels(): readonly IByokLmModelInfo[] {
		return this._servingEntry()?.models ?? [];
	}

	waitForInitialSnapshot(clientId: string): Promise<void> {
		const existing = this._entries.get(clientId)?.initialSnapshot;
		if (existing) {
			return existing.p;
		}
		let pending = this._pendingInitialSnapshots.get(clientId);
		if (!pending) {
			pending = new DeferredPromise<void>();
			this._pendingInitialSnapshots.set(clientId, pending);
		}
		return pending.p;
	}

	getServingConnection(): IByokLmBridgeConnection | undefined {
		return this._servingEntry()?.connection;
	}

	resolveProviderConfiguration(modelIdentifier: string): Promise<IByokLmProviderConfiguration | undefined> {
		return this._servingEntry()?.connection.resolveProviderConfiguration?.(modelIdentifier) ?? Promise.resolve(undefined);
	}

	/**
	 * A serving connection (`models` defined), preferring one whose model set is
	 * non-empty. All serving windows expose the same models, so any populated one
	 * is equivalent; the preference matters when a still-starting window pushes an
	 * empty list first — it must not shadow a peer that already has them. Falls
	 * back to a serving-but-empty window; non-serving windows are skipped.
	 */
	private _servingEntry(): IConnectionEntry | undefined {
		let emptyFallback: IConnectionEntry | undefined;
		for (const entry of this._entries.values()) {
			if (entry.models === undefined) {
				continue;
			}
			if (entry.models.length > 0) {
				return entry;
			}
			emptyFallback ??= entry;
		}
		return emptyFallback;
	}
}

/** Shallow structural comparison of two model lists (order-sensitive). */
function modelsEqual(a: readonly IByokLmModelInfo[], b: readonly IByokLmModelInfo[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return a.every((m, i) => {
		const n = b[i];
		return m.vendor === n.vendor
			&& m.id === n.id
			&& m.name === n.name
			&& m.modelIdentifier === n.modelIdentifier
			&& m.maxContextWindowTokens === n.maxContextWindowTokens
			&& m.maxOutputTokens === n.maxOutputTokens
			&& m.supportsVision === n.supportsVision
			&& m.hidden === n.hidden
			&& m.defaultReasoningEffort === n.defaultReasoningEffort
			&& arraysEqual(m.supportedHarnesses, n.supportedHarnesses)
			&& arraysEqual(m.supportedReasoningEfforts, n.supportedReasoningEfforts);
	});
}

function arraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]));
}

/**
 * No-op {@link IByokLmBridgeRegistry} for agent host entrypoints that do not
 * support BYOK — e.g. the remote agent host, where no extension host runs
 * alongside the agent host to serve the renderer LM API.
 */
export class NullByokLmBridgeRegistry implements IByokLmBridgeRegistry {

	declare readonly _serviceBrand: undefined;

	register(): IDisposable {
		return Disposable.None;
	}

	getModels(): readonly IByokLmModelInfo[] {
		return [];
	}

	getServingConnection(): IByokLmBridgeConnection | undefined {
		return undefined;
	}

	resolveProviderConfiguration(): Promise<undefined> {
		return Promise.resolve(undefined);
	}

	onDidChangeModels(): IDisposable {
		return Disposable.None;
	}
}
