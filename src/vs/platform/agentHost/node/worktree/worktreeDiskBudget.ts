/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import { join } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';

type WorktreeFileSystem = Pick<typeof fs, 'lstat' | 'readdir'>;

let worktreeFileSystemPromise: Promise<WorktreeFileSystem> | undefined;

/**
 * Electron's patched `fs` treats every `.asar` path as an archive, even when a
 * repository intentionally contains an invalid `.asar` test fixture. Disk
 * accounting must inspect the real filesystem. Plain Node does not expose
 * `original-fs`, so unit tests and non-Electron hosts fall back to regular fs.
 */
function getWorktreeFileSystem(): Promise<WorktreeFileSystem> {
	return worktreeFileSystemPromise ??= import('original-fs')
		.then(module => module.promises)
		.catch(() => fs);
}

/** Environment variable that opts into a total Fumie worktree disk budget. */
export const FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR = 'FUMIE_WORKTREE_DISK_BUDGET_BYTES';

/** Parses the optional disk-budget environment value; an unset value disables enforcement. */
export function parseWorktreeDiskBudgetBytes(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const budget = Number(value);
	if (value.trim() === '' || !Number.isSafeInteger(budget) || budget < 0) {
		throw new RangeError(`${FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR} must be a finite, non-negative integer byte count; received ${JSON.stringify(value)}.`);
	}
	return budget;
}

/** A Fumie-managed worktree considered for disk-budget reclamation. */
export interface IWorktreeDiskBudgetCandidate {
	readonly sessionId: string;
	readonly worktreePath: string;
	readonly lastUsedAt: number;
	readonly running: boolean;
	readonly pinned: boolean;
	readonly dirty: boolean;
}

/** Disk usage before and after a reclamation pass, expressed in bytes. */
export interface IWorktreeDiskBudgetResult {
	readonly before: number;
	readonly after: number;
	readonly reclaimed: number;
}

/** Callback that removes one worktree through its owning lifecycle service. */
export type WorktreeDiskBudgetRemover<T extends IWorktreeDiskBudgetCandidate = IWorktreeDiskBudgetCandidate> = (candidate: T) => Promise<void>;

/** Raised when protected or unreclaimed worktrees keep total usage above budget. */
export class WorktreeDiskBudgetExceededError extends Error {
	constructor(
		readonly budget: number,
		readonly result: IWorktreeDiskBudgetResult,
	) {
		super(localize(
			'worktreeDiskBudgetExceeded',
			"Worktree disk usage is {0} bytes, exceeding the {1}-byte budget; no more clean idle worktrees can be reclaimed.",
			result.after,
			budget,
		));
		this.name = 'WorktreeDiskBudgetExceededError';
	}
}

function isFileNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function measureEntry(path: string): Promise<number> {
	const worktreeFileSystem = await getWorktreeFileSystem();
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await worktreeFileSystem.lstat(path);
	} catch (error) {
		if (isFileNotFound(error)) {
			return 0;
		}
		throw error;
	}

	// lstat reports the link itself. Returning here is what prevents a link to a
	// dependency tree (or any location outside the worktree) from being followed.
	const allocatedBytes = typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		return allocatedBytes;
	}

	let entries: string[];
	try {
		entries = await worktreeFileSystem.readdir(path);
	} catch (error) {
		if (isFileNotFound(error)) {
			return 0;
		}
		throw error;
	}

	let bytes = allocatedBytes;
	for (const entry of entries) {
		bytes += await measureEntry(join(path, entry));
	}
	return bytes;
}

/** Recursively measures a worktree without following symbolic links. */
export async function measureWorktreeDiskUsage(worktreePath: string): Promise<number> {
	return measureEntry(worktreePath);
}

/**
 * Enforces the total worktree budget. Selection is deliberately separate from
 * deletion: the owner supplies the remover so Git and session lifecycle cleanup
 * remain on the authoritative path.
 */
export class WorktreeDiskBudget {
	constructor(readonly budget: number | undefined = undefined) {
		if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
			throw new RangeError('Worktree disk budget must be a finite, non-negative integer byte count.');
		}
	}

	/** Whether automatic disk-budget enforcement is explicitly enabled. */
	get isEnabled(): boolean {
		return this.budget !== undefined;
	}

	/** Returns total usage for the explicit candidate set. */
	async getUsage(candidates: readonly IWorktreeDiskBudgetCandidate[]): Promise<number> {
		let bytes = 0;
		for (const candidate of candidates) {
			bytes += await measureWorktreeDiskUsage(candidate.worktreePath);
		}
		return bytes;
	}

	/** Reclaims clean idle worktrees in least-recently-used order. */
	async reclaim<T extends IWorktreeDiskBudgetCandidate>(
		candidates: readonly T[],
		remover: WorktreeDiskBudgetRemover<T>,
	): Promise<IWorktreeDiskBudgetResult | undefined> {
		const budget = this.budget;
		if (budget === undefined) {
			return undefined;
		}

		const before = await this.getUsage(candidates);
		let after = before;
		let reclaimed = 0;

		const reclaimable = candidates
			.filter(candidate => !candidate.running && !candidate.pinned && !candidate.dirty)
			.map((candidate, index) => ({ candidate, index }))
			.sort((left, right) => left.candidate.lastUsedAt - right.candidate.lastUsedAt || left.index - right.index);

		for (const { candidate } of reclaimable) {
			if (after <= budget) {
				break;
			}

			const candidateBefore = await measureWorktreeDiskUsage(candidate.worktreePath);
			await remover(candidate);
			const candidateAfter = await measureWorktreeDiskUsage(candidate.worktreePath);
			reclaimed += Math.max(0, candidateBefore - candidateAfter);
			after = await this.getUsage(candidates);
		}

		const result = { before, after, reclaimed };
		if (after > budget) {
			throw new WorktreeDiskBudgetExceededError(budget, result);
		}
		return result;
	}
}
