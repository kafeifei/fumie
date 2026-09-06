/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { homedir } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, join, resolve } from '../../../../base/common/path.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { AgentHostFumieHomeEnvVar, expandAgentHostUserPath } from '../../common/agentHostProductEnv.js';
import type { ClaudeChatBackingStorage } from './claudeChatBackingCodec.js';
import { ClaudeSessionStore } from './claudeSessionStore.js';

/**
 * Claude Code's own env var for its state directory. Unlike `$CODEX_HOME` and
 * `$COPILOT_HOME`, this one is deliberately NOT dispatched onto the agent host
 * process: the process-level root stays the user's native store so
 * `legacy-local-v0` backings remain readable. Fumie's own sessions are routed
 * off it per call — see {@link ClaudeBackingStore}.
 */
export const ClaudeConfigDirEnvVar = 'CLAUDE_CONFIG_DIR';

/**
 * Where the CLI looks up its OS credential store. The SDK derives the macOS
 * Keychain service name from the config dir — `Claude Code-credentials` when
 * neither variable is set, but `Claude Code-credentials-<hash of
 * $CLAUDE_CONFIG_DIR>` once we move the config dir — so isolating transcripts
 * would otherwise hide the user's own `claude /login` from every Fumie
 * session. Setting this to the empty string is the SDK's own escape: an
 * explicitly empty value restores the unsuffixed name, so transcripts move
 * while first-party auth stays exactly where the user put it.
 */
export const ClaudeSecureStorageConfigDirEnvVar = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/** The user's global Claude instructions, shared into the isolated home. */
const ClaudeInstructionsFile = 'CLAUDE.md';

async function isFile(path: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(path)).isFile();
	} catch {
		return false;
	}
}

async function readLinkTarget(path: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.lstat(path);
		return stat.isSymbolicLink() ? resolve(dirname(path), await fs.promises.readlink(path)) : undefined;
	} catch {
		return undefined;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.promises.lstat(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ENOENT';
	}
}

/** SQLite file holding the Fumie-owned Claude transcripts. */
const FumieStoreFile = 'sessions.db';

/**
 * Resolve the Fumie home directory. Same precedence as
 * {@link resolveCodexBackingHomes}: an explicit `FUMIE_HOME` (possibly
 * `~`-relative) wins, else `~/.fumie`.
 */
export function resolveFumieHome(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): string {
	return expandAgentHostUserPath(env[AgentHostFumieHomeEnvVar]) ?? join(userHome, '.fumie');
}

/** The two Claude stores, resolved without deriving one from the other. */
export interface IClaudeBackingHomes {
	/** Fumie-owned namespace: `$FUMIE_HOME/providers/claude`. */
	readonly fumie: string;
	/** The user's own Claude Code store, shared with the CLI and desktop app. */
	readonly native: string;
}

export function resolveClaudeBackingHomes(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): IClaudeBackingHomes {
	return {
		fumie: join(resolveFumieHome(env, userHome), 'providers', 'claude'),
		native: expandAgentHostUserPath(env[ClaudeConfigDirEnvVar]) ?? join(userHome, '.claude'),
	};
}

/** Per-call SDK routing for one backing: which store, and which project dir. */
export interface IClaudeStoreRouting {
	readonly sessionStore?: SessionStore;
	readonly dir?: string;
}

export const IClaudeBackingStore = createDecorator<IClaudeBackingStore>('claudeBackingStore');

export interface IClaudeBackingStore {
	readonly _serviceBrand: undefined;
	readonly homes: IClaudeBackingHomes;
	readonly fumieStore: SessionStore;
	readonly subprocessConfigDir: string;
	prepareFumieHome(): Promise<void>;
	readGlobalClaudeMd(): Promise<string | undefined>;
	routing(storage: ClaudeChatBackingStorage | undefined): IClaudeStoreRouting;
	newBackingStorage(projectDir: string): ClaudeChatBackingStorage;
}

/**
 * Fumie's Claude transcript namespace, and the routing that keeps it separate
 * from the user's own Claude Code store.
 *
 * Both stores live under one root each and are never derived from each other:
 *
 * - **Fumie** (`$FUMIE_HOME/providers/claude`) holds every session Fumie
 *   creates. Subprocesses are pointed at it through `Options.env`, and the
 *   authoritative copy Fumie reads back is the {@link ClaudeSessionStore}
 *   mirror — the SDK accepts it per call, so nothing has to flip a
 *   process-level `$CLAUDE_CONFIG_DIR` and race with a concurrent read.
 * - **Native** (`~/.claude`, or an inherited `$CLAUDE_CONFIG_DIR`) is the
 *   user's. Fumie reaches into it only by exact reference, for the
 *   `legacy-local-v0` backings written before this split existed.
 *
 * This is the structural cure for the crossed-store bugs that four successive
 * discovery filters could not close: while both sides shared `~/.claude`,
 * ownership could only ever be *inferred* from the outside (cwd, entrypoint,
 * a sibling directory's existence), and every such inference had a next
 * counter-example. Routing by the session's own durable receipt has none —
 * a chat Fumie did not create has no receipt, and is not in Fumie's store.
 *
 * The mirror is a mirror, not a relocation: the SDK still writes JSONL under
 * whatever `$CLAUDE_CONFIG_DIR` the subprocess sees, which is exactly why
 * {@link subprocessEnv} must be applied to every Fumie-spawned query. Setting
 * only one of the two would leave transcripts in the user's store.
 */
export class ClaudeBackingStore extends Disposable implements IClaudeBackingStore {

	declare readonly _serviceBrand: undefined;

	readonly homes: IClaudeBackingHomes;
	private readonly _fumieStore: ClaudeSessionStore;

	constructor(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()) {
		super();
		this.homes = resolveClaudeBackingHomes(env, userHome);
		// Fully lazy: the database file is created on the first append/read.
		this._fumieStore = this._register(new ClaudeSessionStore(join(this.homes.fumie, FumieStoreFile)));
	}

	/** The store every newly created Fumie session is written into. */
	get fumieStore(): SessionStore {
		return this._fumieStore;
	}

	/**
	 * `$CLAUDE_CONFIG_DIR` for a Fumie-spawned Claude subprocess, so its local
	 * JSONL lands in Fumie's namespace instead of the user's `~/.claude`.
	 */
	get subprocessConfigDir(): string {
		return this.homes.fumie;
	}

	/**
	 * SDK options addressing the store that actually holds `storage`.
	 *
	 * A `fumie-store-v1` receipt routes to the mirror; a `legacy-local-v0` one
	 * (or a receipt too old to say) resolves against the process-level root,
	 * which is the native store — the exact-reference path docs/architecture.md requires
	 * instead of a scanning migration.
	 */
	routing(storage: ClaudeChatBackingStorage | undefined): IClaudeStoreRouting {
		const dir = storage?.projectDir ? { dir: storage.projectDir } : {};
		return storage?.kind === 'fumie-store-v1'
			? { sessionStore: this._fumieStore, ...dir }
			: dir;
	}

	/**
	 * Make the user's global `CLAUDE.md` readable from the isolated home.
	 *
	 * Moving `$CLAUDE_CONFIG_DIR` moves every input the CLI resolves against
	 * it, and the user's global instructions are the one that must not go
	 * quiet: they are a single authored file, and losing them changes how the
	 * agent behaves with nothing on screen to say so. A symlink keeps one
	 * source of truth in the native home — editing either path edits the same
	 * file — which is what {@link prepareFumieCodexHome} does for `AGENTS.md`.
	 *
	 * Only Fumie's own link is ever touched: a real file or a link pointing
	 * somewhere else is the user's and is preserved as-is, and a stale link is
	 * dropped once the native file is gone. Best-effort by contract — a
	 * failure here must not stop a session from starting.
	 *
	 * The link serves the two routed transports, whose sessions load it through
	 * the `user` setting source. Native pins `settingSources: []` for provider
	 * isolation and so reads no instruction file off disk at all; there the
	 * same instructions reach the model through the system prompt instead —
	 * see {@link readGlobalClaudeMd} and `buildOptions`.
	 */
	async prepareFumieHome(): Promise<void> {
		const source = join(this.homes.native, ClaudeInstructionsFile);
		const target = join(this.homes.fumie, ClaudeInstructionsFile);
		await fs.promises.mkdir(this.homes.fumie, { recursive: true, mode: 0o700 });
		const current = await readLinkTarget(target);
		const wanted = (await isFile(source)) ? resolve(source) : undefined;
		if (current === wanted) {
			return;
		}
		if (current !== undefined) {
			// Ours to replace only while it still points at the native file;
			// any other link target was authored by the user.
			if (current === resolve(source) || wanted === undefined) {
				await fs.promises.unlink(target);
			}
			if (wanted === undefined) {
				return;
			}
		}
		if (wanted === undefined || await pathExists(target)) {
			return;
		}
		await fs.promises.symlink(source, target, 'file');
	}

	/**
	 * The user's global `CLAUDE.md`, verbatim, for the transports that cannot
	 * load it off disk — see {@link prepareFumieHome}. Resolves to `undefined`
	 * when there is no such file, when it is empty, or when it cannot be read:
	 * like the link, this is best-effort and must never fail a session start.
	 */
	async readGlobalClaudeMd(): Promise<string | undefined> {
		try {
			const content = await fs.promises.readFile(join(this.homes.native, ClaudeInstructionsFile), 'utf8');
			return content.trim().length > 0 ? content : undefined;
		} catch {
			return undefined;
		}
	}

	/** The storage receipt every newly minted Fumie backing carries. */
	newBackingStorage(projectDir: string): ClaudeChatBackingStorage {
		return { kind: 'fumie-store-v1', projectDir };
	}
}
