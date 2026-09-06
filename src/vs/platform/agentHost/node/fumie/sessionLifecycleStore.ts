/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IAgentHostDatabase, IAgentHostDatabaseSessionDeleteIntent, IAgentHostDatabaseSessionLifecycle } from '../agentHostDatabase.js';

export type SessionDeletePhase = 'prepared' | 'stopping' | 'deletingBackings' | 'cleaningFumie';

export interface ISessionDeleteTarget {
	readonly chat: string;
	readonly providerData?: string;
	readonly status: 'pending' | 'deleted';
}

export interface ISessionDeleteIntent {
	readonly operationId: string;
	readonly session: string;
	readonly provider: string;
	readonly phase: SessionDeletePhase;
	readonly targets: readonly ISessionDeleteTarget[];
	readonly attempt: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastError?: string;
}

export interface ISessionDeleteIntentPatch {
	readonly phase?: SessionDeletePhase;
	readonly targets?: readonly ISessionDeleteTarget[];
	readonly attempt?: number;
	/** `null` clears an earlier error. */
	readonly lastError?: string | null;
	readonly updatedAt: number;
}

const deletePhases = new Set<SessionDeletePhase>(['prepared', 'stopping', 'deletingBackings', 'cleaningFumie']);

/**
 * Durable Fumie lifecycle transaction store.
 *
 * Delete intents live beside catalog membership rather than in a session's own
 * database. This lets cleanup remove the per-session database before the final
 * catalog transaction atomically tombstones, unregisters, and clears the
 * intent.
 */
export class SessionLifecycleStore {

	private readonly _database: IAgentHostDatabaseSessionLifecycle;

	constructor(database: IAgentHostDatabase) {
		if (!database.sessionLifecycle) {
			throw new Error('Agent Host database does not support session lifecycle transactions');
		}
		this._database = database.sessionLifecycle;
	}

	/** Insert `intent`, or return the previously prepared intent for the session. */
	async prepare(intent: ISessionDeleteIntent): Promise<ISessionDeleteIntent> {
		validateDeleteIntent(intent);
		return fromDatabaseIntent(await this._database.prepareDeleteIntent(toDatabaseIntent(intent)));
	}

	async get(session: URI | string): Promise<ISessionDeleteIntent | undefined> {
		const intent = await this._database.getDeleteIntent(sessionKey(session));
		return intent ? fromDatabaseIntent(intent) : undefined;
	}

	async list(): Promise<readonly ISessionDeleteIntent[]> {
		return (await this._database.listDeleteIntents()).map(fromDatabaseIntent);
	}

	/** Conditionally update the intent still owned by `operationId`. */
	async update(session: URI | string, operationId: string, patch: ISessionDeleteIntentPatch): Promise<ISessionDeleteIntent> {
		const key = sessionKey(session);
		const current = await this.get(key);
		if (!current || current.operationId !== operationId) {
			throw new Error(`Session deletion is not owned by operation ${operationId}: ${key}`);
		}
		const next: ISessionDeleteIntent = {
			...current,
			...(patch.phase !== undefined ? { phase: patch.phase } : {}),
			...(patch.targets !== undefined ? { targets: patch.targets } : {}),
			...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
			updatedAt: patch.updatedAt,
			...(patch.lastError !== undefined
				? patch.lastError === null ? { lastError: undefined } : { lastError: patch.lastError }
				: {}),
		};
		validateDeleteIntent(next);
		const updated = await this._database.updateDeleteIntent(key, operationId, {
			phase: next.phase,
			targetsJson: JSON.stringify(next.targets),
			attempt: next.attempt,
			updatedAt: next.updatedAt,
			lastError: next.lastError,
		});
		if (!updated) {
			throw new Error(`Session deletion changed while operation ${operationId} was updating it: ${key}`);
		}
		return next;
	}

	/** Atomically tombstone, unregister, and clear the matching delete intent. */
	async finalize(session: URI | string, operationId: string): Promise<void> {
		const key = sessionKey(session);
		if (!await this._database.finalizeDeleteIntent(key, operationId)) {
			throw new Error(`Session deletion is not owned by operation ${operationId}: ${key}`);
		}
	}
}

function sessionKey(session: URI | string): string {
	return typeof session === 'string' ? session : session.toString();
}

function toDatabaseIntent(intent: ISessionDeleteIntent): IAgentHostDatabaseSessionDeleteIntent {
	return {
		session: intent.session,
		operationId: intent.operationId,
		provider: intent.provider,
		phase: intent.phase,
		targetsJson: JSON.stringify(intent.targets),
		attempt: intent.attempt,
		createdAt: intent.createdAt,
		updatedAt: intent.updatedAt,
		lastError: intent.lastError,
	};
}

function fromDatabaseIntent(intent: IAgentHostDatabaseSessionDeleteIntent): ISessionDeleteIntent {
	let targets: unknown;
	try {
		targets = JSON.parse(intent.targetsJson);
	} catch (error) {
		throw new Error(`Invalid delete targets for ${intent.session}`, { cause: error });
	}
	const value: ISessionDeleteIntent = {
		operationId: intent.operationId,
		session: intent.session,
		provider: intent.provider,
		phase: intent.phase as SessionDeletePhase,
		targets: targets as readonly ISessionDeleteTarget[],
		attempt: intent.attempt,
		createdAt: intent.createdAt,
		updatedAt: intent.updatedAt,
		...(intent.lastError !== undefined ? { lastError: intent.lastError } : {}),
	};
	validateDeleteIntent(value);
	return value;
}

function validateDeleteIntent(intent: ISessionDeleteIntent): void {
	if (!intent.operationId || !intent.session || !intent.provider) {
		throw new Error('Session delete intent requires operationId, session, and provider');
	}
	if (!deletePhases.has(intent.phase)) {
		throw new Error(`Invalid session delete phase: ${intent.phase}`);
	}
	if (!Number.isInteger(intent.attempt) || intent.attempt < 0) {
		throw new Error(`Invalid session delete attempt: ${intent.attempt}`);
	}
	if (!Number.isFinite(intent.createdAt) || !Number.isFinite(intent.updatedAt)) {
		throw new Error('Session delete intent timestamps must be finite numbers');
	}
	if (!Array.isArray(intent.targets)) {
		throw new Error('Session delete targets must be an array');
	}
	const chats = new Set<string>();
	for (const target of intent.targets) {
		if (!target || typeof target.chat !== 'string' || !target.chat) {
			throw new Error('Session delete target requires a chat URI');
		}
		if (chats.has(target.chat)) {
			throw new Error(`Duplicate session delete target: ${target.chat}`);
		}
		chats.add(target.chat);
		if (target.providerData !== undefined && typeof target.providerData !== 'string') {
			throw new Error(`Invalid provider data for session delete target: ${target.chat}`);
		}
		if (target.status !== 'pending' && target.status !== 'deleted') {
			throw new Error(`Invalid session delete target status: ${target.chat}`);
		}
	}
}
