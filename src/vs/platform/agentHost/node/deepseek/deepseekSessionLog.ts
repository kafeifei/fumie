/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, readdir, stat } from 'fs/promises';
import { createZstdDecompress } from 'zlib';
import { join } from '../../../../base/common/path.js';
import type { IDeepSeekSessionHeader } from './deepseekSdkService.js';

/**
 * Reads the DeepSeek Harness's durable session log directly.
 *
 * `IAgent.getChatMetadata` is the host's cold-read contract — describe a
 * registered chat from durable state alone — and that durable state is one
 * append-only JSONL log per session, zstd-framed, under `$DSH_HOME/sessions`.
 * Fumie reads the log itself instead of asking the harness's session catalog,
 * for two reasons.
 *
 * The catalog listing is all-or-nothing. It walks every project directory and
 * throws out of the entire scan on the first log it dislikes, so ONE unreadable
 * session makes EVERY session undescribable; the host then reports each of them
 * as `Provider deepseek cannot read the conversation recorded for <session>`
 * and reopens none of them. Reading per session is what makes one damaged log
 * cost one session.
 *
 * And it dislikes logs the harness itself wrote. Its reader asserts that the
 * first zstd frame decodes to exactly one line, which holds only for logs the
 * current writer produced — a dedicated header frame, then one frame per append
 * batch. A log rewritten by an older writer (relocating a session to a new
 * working directory re-encodes it under a new project key) carries the header
 * and every record in a SINGLE frame. Those logs are intact JSONL, but that
 * assertion rejects them outright:
 *
 *   corrupt Zstandard session log: first frame is not exactly one header line
 *
 * Looking for the first decompressed LINE rather than asserting the shape of
 * the first FRAME is blind to that difference, so both layouts read the same
 * way — and a cold describe costs one file read rather than booting a whole
 * composition to ask it.
 */

/** The persistence backend's per-session artifact, one per session directory. */
const SESSION_LOG_NAME = 'session.jsonl.zstd';

/**
 * Decompressed bytes to scan for the header line's terminating newline before
 * giving up. The header is the log's first record and runs a few hundred bytes;
 * a log that has produced a megabyte without one is not a session log we can
 * describe, and stopping keeps a malformed artifact from being decoded whole
 * into memory.
 */
const MAX_HEADER_SCAN_BYTES = 1024 * 1024;

/**
 * Session ids as the store spells them in a path. The backend percent-escapes
 * anything outside this set, but every id Fumie registers is a uuid, for which
 * that encoding is the identity — so ids are used verbatim and ones that would
 * need escaping (or would escape the root) are simply not ours to find.
 */
const PATH_SAFE_ID = /^[A-Za-z0-9._-]+$/;

const NEWLINE = 0x0a;

/**
 * What the durable store holds for one session id. `absent` and `damaged` are
 * kept apart because they deserve opposite answers: a session with nothing
 * stored may still be arriving, while one whose every stored log has already
 * been read and could not be parsed will read the same way forever.
 */
export type DeepSeekStoredSession =
	/** A stored log yielded a header describing this session. */
	| { readonly kind: 'described'; readonly header: IDeepSeekSessionHeader }
	/** No log is stored under this id. */
	| { readonly kind: 'absent' }
	/** A log is stored, but no copy of it yields a readable header. */
	| { readonly kind: 'damaged'; readonly path: string };

/**
 * Describe session `id` from the durable store.
 *
 * A log lives at `<sessionsRoot>/<project-key>/<id>/session.jsonl.zstd`, where
 * the project key encodes the working directory the session was created in.
 * That directory is unknown to a cold describe, so this probes each project for
 * the id: one `stat` per project and at most one decode.
 *
 * Relocating a session writes it under a new project key without removing the
 * old copy, so one id can be stored more than once with a different `cwd` in
 * each. The most recently written copy is the live one and is tried first; an
 * unreadable copy falls through to an older readable one rather than failing
 * the read.
 */
export async function readDeepSeekStoredSession(sessionsRoot: string, id: string): Promise<DeepSeekStoredSession> {
	if (!PATH_SAFE_ID.test(id) || id === '.' || id === '..') {
		return { kind: 'absent' };
	}
	const paths = await storedLogPaths(sessionsRoot, id);
	for (const path of paths) {
		const header = await readHeaderAt(path);
		// A log filed under some other id is a store this session does not own.
		if (header?.id === id) {
			return { kind: 'described', header };
		}
	}
	return paths.length === 0 ? { kind: 'absent' } : { kind: 'damaged', path: paths[0] };
}

/** Every stored log for `id`, most recently written first. */
async function storedLogPaths(sessionsRoot: string, id: string): Promise<readonly string[]> {
	let projects;
	try {
		projects = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		// No store yet — the provider has never persisted a session here.
		return [];
	}
	const stored: { readonly path: string; readonly mtimeMs: number }[] = [];
	for (const project of projects) {
		if (!project.isDirectory()) {
			continue;
		}
		const path = join(sessionsRoot, project.name, id, SESSION_LOG_NAME);
		try {
			stored.push({ path, mtimeMs: (await stat(path)).mtimeMs });
		} catch {
			// This project does not hold the session; the next one might.
		}
	}
	return stored.sort((left, right) => right.mtimeMs - left.mtimeMs).map(entry => entry.path);
}

/** The header record of one stored log, or `undefined` if it has none we can read. */
async function readHeaderAt(path: string): Promise<IDeepSeekSessionHeader | undefined> {
	let compressed: Buffer;
	try {
		compressed = await readFile(path);
	} catch {
		return undefined;
	}
	const line = await firstLine(compressed);
	return line === undefined ? undefined : parseHeaderLine(line);
}

/**
 * The log's first decompressed line, without decoding more of it than it takes
 * to find that line.
 *
 * This is also what recovers a log torn by a hard kill: the decoder surfaces
 * its error only after the bytes it already produced, so a header that made it
 * to disk still wins the race against a corrupt tail. A header that did not —
 * a log truncated inside its first record, or bytes that are not a Zstandard
 * frame at all — yields `undefined` rather than throwing, because one
 * unreadable log must not fail a read for any other session.
 */
function firstLine(compressed: Buffer): Promise<string | undefined> {
	return new Promise<string | undefined>(resolve => {
		const decoder = createZstdDecompress();
		const decoded: Buffer[] = [];
		let scanned = 0;
		let settled = false;
		const settle = (line: string | undefined) => {
			if (!settled) {
				settled = true;
				// Stop the decoder where it stands: the rest of the log is the
				// caller's concern only when it replays the session, not now.
				decoder.destroy();
				resolve(line);
			}
		};
		decoder.on('data', (chunk: Buffer) => {
			decoded.push(chunk);
			scanned += chunk.length;
			if (chunk.indexOf(NEWLINE) !== -1) {
				const plaintext = Buffer.concat(decoded);
				settle(plaintext.subarray(0, plaintext.indexOf(NEWLINE)).toString('utf8'));
			} else if (scanned > MAX_HEADER_SCAN_BYTES) {
				settle(undefined);
			}
		});
		decoder.on('error', () => settle(undefined));
		decoder.on('end', () => settle(undefined));
		decoder.end(compressed);
	});
}

/**
 * Validate the log's first record as a session header. The stored line is
 * `{"type":"session","version":0,"id":…,"createdAt":…,"cwd":…}`; anything else
 * is not a header, and `cwd` is absent for a session created without one.
 */
function parseHeaderLine(line: string): IDeepSeekSessionHeader | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const record = parsed as { readonly type?: unknown; readonly id?: unknown; readonly createdAt?: unknown; readonly cwd?: unknown };
	if (record.type !== 'session' || typeof record.id !== 'string' || typeof record.createdAt !== 'number') {
		return undefined;
	}
	return {
		id: record.id,
		createdAt: record.createdAt,
		...(typeof record.cwd === 'string' && record.cwd.length > 0 ? { cwd: record.cwd } : {}),
	};
}
