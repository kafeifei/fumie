/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * Prefix the Claude SDK gives the throwaway `$CLAUDE_CONFIG_DIR` it
 * materializes under `os.tmpdir()` for every store-backed resume
 * (`claude-resume-<uuid>`).
 */
const RESUME_DIR_PREFIX = 'claude-resume-';

/** `claude-resume-` followed by exactly the SDK's uuid. Nothing else is ours. */
const RESUME_DIR_NAME = /^claude-resume-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Top-level *directories* a materialized resume dir is allowed to contain:
 * `projects/` from the SDK's materializer, the rest created by the CLI once it
 * is up on this config dir. Kept as a closed set because a stray directory is
 * the shape a foreign tree would have; loose files are handled separately by
 * {@link isKnownConfigFile}.
 */
const KNOWN_DIRECTORIES: ReadonlySet<string> = new Set([
	'projects',
	'backups',
	'file-history',
	'ide',
	'plugins',
	'session-env',
	'sessions',
	'shell-snapshots',
	'statsig',
	'todos',
]);

/**
 * Whether a loose top-level file is Claude config state. The CLI keeps adding
 * caches next to `.claude.json` (`mcp-needs-auth-cache.json` and friends), so
 * enumerating them by name would quietly turn this sweep off the next time the
 * CLI grows one — which is exactly how the leak went unnoticed. Match the
 * shape instead: config/JSON state and the CLI's own dotfiles.
 */
function isKnownConfigFile(name: string): boolean {
	return name.endsWith('.json')
		|| name.endsWith('.jsonl')
		|| name.startsWith('.claude.json.backup')
		|| name === '.last-cleanup'
		|| name === '.credentials.json';
}

/**
 * A directory untouched for this long is assumed orphaned. Generous on
 * purpose: the cost of waiting is a few megabytes of temp, the cost of being
 * wrong is deleting the config dir out from under a live subprocess.
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How far down the tree the liveness scan looks for a recent write. */
const MAX_SCAN_DEPTH = 4;

export interface IClaudeResumeTempCleanupOptions {
	/** Defaults to `os.tmpdir()`. */
	readonly tmpDir?: string;
	/** Defaults to {@link DEFAULT_MAX_AGE_MS}. */
	readonly maxAgeMs?: number;
	/** Defaults to `Date.now()`. */
	readonly now?: number;
}

export interface IClaudeResumeTempCleanupResult {
	readonly removed: readonly string[];
	/** Directories left in place because they still look live. */
	readonly keptRecent: number;
	/** Directories left in place because their contents were not recognizable. */
	readonly keptUnrecognized: number;
}

/**
 * Delete Claude resume scratch directories that no live subprocess can still
 * own.
 *
 * The SDK removes `claude-resume-<uuid>` when the query it materialized shuts
 * down, which means the cleanup only ever runs if the *host* outlives the
 * subprocess. Any host crash, force-quit or reload therefore strands a
 * directory forever, and they accumulate one per resume — a machine that has
 * been running Fumie for a few days carries dozens of full transcript copies
 * in temp, credentials file included.
 *
 * Called once per agent-host start, so it must never be able to hurt the
 * startup it runs inside: it is fire-and-forget, every failure degrades to a
 * warning, and a directory is only removed when *both* guards agree — a
 * `claude-resume-<uuid>` name holding nothing but recognizable SDK/CLI state,
 * and no write anywhere inside it for {@link DEFAULT_MAX_AGE_MS}. Anything
 * else is left for the next host to reconsider.
 */
export async function cleanupOrphanedClaudeResumeDirs(
	logService: ILogService,
	options: IClaudeResumeTempCleanupOptions = {},
): Promise<IClaudeResumeTempCleanupResult> {
	const tmpDir = options.tmpDir ?? os.tmpdir();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const cutoff = (options.now ?? Date.now()) - maxAgeMs;
	const result = { removed: [] as string[], keptRecent: 0, keptUnrecognized: 0 };

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(tmpDir, { withFileTypes: true });
	} catch (err) {
		logService.warn(`[ClaudeResumeTempCleanup] could not scan ${tmpDir}: ${err}`);
		return result;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(RESUME_DIR_PREFIX)) {
			continue;
		}
		const dir = join(tmpDir, entry.name);
		try {
			if (!RESUME_DIR_NAME.test(entry.name)) {
				logService.warn(`[ClaudeResumeTempCleanup] keeping ${entry.name}: name is not a materialized resume dir`);
				result.keptUnrecognized++;
				continue;
			}
			const unexpected = await findUnexpectedEntry(dir);
			if (unexpected !== undefined) {
				logService.warn(`[ClaudeResumeTempCleanup] keeping ${entry.name}: unrecognized content '${unexpected}'`);
				result.keptUnrecognized++;
				continue;
			}
			if (await hasWriteSince(dir, cutoff, MAX_SCAN_DEPTH)) {
				result.keptRecent++;
				continue;
			}
			await fs.promises.rm(dir, { recursive: true, force: true });
			result.removed.push(entry.name);
		} catch (err) {
			logService.warn(`[ClaudeResumeTempCleanup] keeping ${entry.name}: ${err}`);
		}
	}

	if (result.removed.length > 0 || result.keptUnrecognized > 0) {
		logService.info(`[ClaudeResumeTempCleanup] removed ${result.removed.length} orphaned resume dir(s); kept ${result.keptRecent} recent, ${result.keptUnrecognized} unrecognized`);
	}
	return result;
}

let sweepStarted = false;

/**
 * Kick off {@link cleanupOrphanedClaudeResumeDirs} for this process, at most
 * once, joined to nothing.
 *
 * The agent host has two entry points that both register the Claude provider
 * and therefore both materialize resume dirs: the desktop utility process
 * (`agentHostMain`) and the standalone WebSocket server
 * (`agentHostServerMain`). They share the runtime bootstrap but not the
 * provider-registration step, so each has to start the sweep itself — the
 * once guard lives here rather than at either call site so that stays a
 * detail of the sweep instead of something the callers have to coordinate.
 *
 * Deliberately not awaited: the sweep is best effort and must never be able to
 * delay or break the host coming up, so every failure it does not already
 * absorb degrades to a warning here.
 */
export function scheduleOrphanedClaudeResumeDirCleanup(logService: ILogService): void {
	if (sweepStarted) {
		return;
	}
	sweepStarted = true;
	void cleanupOrphanedClaudeResumeDirs(logService)
		.catch(err => logService.warn(`[ClaudeResumeTempCleanup] sweep failed: ${err}`));
}

/**
 * The name of the first top-level entry that is not part of a materialized
 * resume dir, or `undefined` when everything is recognizable. A dir with no
 * `projects/` is reported as unrecognized too: that is the one thing the SDK
 * always writes, so its absence means this is not a dir we made.
 */
async function findUnexpectedEntry(dir: string): Promise<string | undefined> {
	let hasProjects = false;
	for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!KNOWN_DIRECTORIES.has(entry.name)) {
				return entry.name;
			}
			hasProjects ||= entry.name === 'projects';
		} else if (!isKnownConfigFile(entry.name)) {
			return entry.name;
		}
	}
	return hasProjects ? undefined : '<no projects/ directory>';
}

/**
 * Whether anything in `dir` was written at or after `cutoff`.
 *
 * The top-level directory's own mtime is not enough on its own: appending to a
 * transcript under `projects/<key>/<session>.jsonl` touches the file, not its
 * ancestors, so a busy session can look untouched from the root. Walk down
 * instead, and stop at the first fresh timestamp — for a live directory that
 * is usually the first file visited.
 */
async function hasWriteSince(dir: string, cutoff: number, depth: number): Promise<boolean> {
	if ((await fs.promises.stat(dir)).mtimeMs >= cutoff) {
		return true;
	}
	if (depth <= 0) {
		return false;
	}
	for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
		const child = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (await hasWriteSince(child, cutoff, depth - 1)) {
				return true;
			}
		} else if ((await fs.promises.stat(child)).mtimeMs >= cutoff) {
			return true;
		}
	}
	return false;
}
