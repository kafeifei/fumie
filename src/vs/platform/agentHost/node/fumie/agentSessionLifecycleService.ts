/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import { ISessionDeleteTarget, SessionLifecycleStore } from './sessionLifecycleStore.js';

export interface IAgentSessionLifecycleHost {
	captureDeleteTargets(session: URI): Promise<readonly Omit<ISessionDeleteTarget, 'status'>[]>;
	stopSessionForDelete(session: URI, targets: readonly ISessionDeleteTarget[]): Promise<void>;
	deleteBacking(session: URI, target: ISessionDeleteTarget): Promise<void>;
	cleanupFumieSession(session: URI): Promise<void>;
	onSessionDeleteFinalized(session: URI): Promise<void> | void;
}

/**
 * Fumie-owned durable lifecycle transaction coordinator.
 *
 * The service knows nothing about Codex, Claude, worktrees, or AHP state. It
 * serializes lifecycle mutations per Fumie session and drives an injected host
 * through a persisted delete state machine. The target snapshot is immutable;
 * only each target's completion bit advances.
 */
export class AgentSessionLifecycleService {

	private readonly _sessionTails = new Map<string, Promise<unknown>>();
	private readonly _deleteOperations = new Map<string, Promise<void>>();
	private readonly _deletingSessions = new Set<string>();
	private readonly _loadPromise: Promise<void>;
	private _ready = false;

	constructor(
		private readonly _store: SessionLifecycleStore,
		private readonly _host: IAgentSessionLifecycleHost,
		private readonly _logService: ILogService,
	) {
		this._loadPromise = this._loadPendingDeletes().then(() => { this._ready = true; });
	}

	private async _loadPendingDeletes(): Promise<void> {
		try {
			for (const intent of await this._store.list()) {
				this._deletingSessions.add(intent.session);
			}
		} catch (error) {
			this._logService.error(error, '[AgentSessionLifecycleService] Failed to load pending delete intents');
			throw error;
		}
	}

	whenReady(): Promise<void> {
		return this._loadPromise;
	}

	get isReady(): boolean {
		return this._ready;
	}

	pendingSessionMutation(session: URI | string): Promise<unknown> | undefined {
		return this._sessionTails.get(sessionKey(session));
	}

	isDeleting(session: URI | string): boolean {
		return this._deletingSessions.has(sessionKey(session));
	}

	async assertMutable(session: URI | string): Promise<void> {
		await this._loadPromise;
		const key = sessionKey(session);
		if (this._deletingSessions.has(key)) {
			throw new Error(`Session is being deleted: ${key}`);
		}
	}

	/** Serialize any Fumie lifecycle mutation with delete for this session. */
	runSessionMutation<T>(session: URI | string, task: () => Promise<T>): Promise<T> {
		const key = sessionKey(session);
		const previous = this._sessionTails.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(task);
		this._sessionTails.set(key, current);
		const cleanup = () => {
			if (this._sessionTails.get(key) === current) {
				this._sessionTails.delete(key);
			}
		};
		void current.then(cleanup, cleanup);
		return current;
	}

	deleteSession(session: URI, provider: string): Promise<void> {
		const key = session.toString();
		const inFlight = this._deleteOperations.get(key);
		if (inFlight) {
			return inFlight;
		}
		// Close the synchronous action gate before waiting behind any earlier
		// lifecycle mutation. The durable intent is the first operation executed
		// once this delete reaches the head of the session tail.
		this._deletingSessions.add(key);
		const operation = this.runSessionMutation(session, () => this._deleteSessionNow(session, provider));
		this._deleteOperations.set(key, operation);
		const cleanup = () => {
			if (this._deleteOperations.get(key) === operation) {
				this._deleteOperations.delete(key);
			}
		};
		void operation.then(cleanup, cleanup);
		return operation;
	}

	async resumePendingDeletes(provider: string): Promise<void> {
		await this._loadPromise;
		const intents = (await this._store.list()).filter(intent => intent.provider === provider);
		const results = await Promise.allSettled(intents.map(intent => this.deleteSession(URI.parse(intent.session), provider)));
		const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failure) {
			throw failure.reason;
		}
	}

	private async _deleteSessionNow(session: URI, provider: string): Promise<void> {
		await this._loadPromise;
		const key = session.toString();
		let intent = await this._store.get(session);
		if (intent && intent.provider !== provider) {
			throw new Error(`Delete intent provider mismatch for ${key}: ${intent.provider} !== ${provider}`);
		}

		if (!intent) {
			const now = Date.now();
			const targets = (await this._host.captureDeleteTargets(session)).map(target => ({ ...target, status: 'pending' as const }));
			intent = await this._store.prepare({
				operationId: generateUuid(),
				session: key,
				provider,
				phase: 'prepared',
				targets,
				attempt: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		this._deletingSessions.add(key);

		try {
			intent = await this._store.update(session, intent.operationId, {
				phase: 'stopping',
				attempt: intent.attempt + 1,
				lastError: null,
				updatedAt: Date.now(),
			});
			await this._host.stopSessionForDelete(session, intent.targets);

			intent = await this._store.update(session, intent.operationId, {
				phase: 'deletingBackings',
				updatedAt: Date.now(),
			});
			let firstDeleteError: unknown;
			for (let index = 0; index < intent.targets.length; index++) {
				const target = intent.targets[index];
				if (target.status === 'deleted') {
					continue;
				}
				try {
					await this._host.deleteBacking(session, target);
				} catch (error) {
					firstDeleteError ??= error;
					continue;
				}
				const targets = intent.targets.map((candidate, candidateIndex) => candidateIndex === index
					? { ...candidate, status: 'deleted' as const }
					: candidate);
				intent = await this._store.update(session, intent.operationId, { targets, updatedAt: Date.now() });
			}
			if (firstDeleteError !== undefined) {
				throw firstDeleteError;
			}

			intent = await this._store.update(session, intent.operationId, {
				phase: 'cleaningFumie',
				updatedAt: Date.now(),
			});
			await this._host.cleanupFumieSession(session);
			await this._store.finalize(session, intent.operationId);
			await this._host.onSessionDeleteFinalized(session);
			this._deletingSessions.delete(key);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this._store.update(session, intent.operationId, {
				lastError: message,
				updatedAt: Date.now(),
			}).catch(storeError => this._logService.error(storeError, `[AgentSessionLifecycleService] Failed to record delete error for ${key}`));
			throw error;
		}
	}
}

function sessionKey(session: URI | string): string {
	return typeof session === 'string' ? session : session.toString();
}
