/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { open } from 'fs/promises';
import type { ClaudeEffortLevel } from '../../common/claudeModelConfig.js';

/**
 * Reads the model catalog Anthropic bakes into the Claude Code CLI executable
 * that ships inside `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`.
 *
 * WHY: `Query.supportedModels()` answers with the handful of rows the CLI would
 * put on its *first* model page — the aliases plus whatever it currently
 * defaults to (five rows against 0.3.260). The CLI's own "More models" page is
 * fed by a much larger catalog that the SDK's control channel never exposes, so
 * every previous-generation model (Opus 4.8 / 4.7 / 4.6, Sonnet 4.6, Fable 5,
 * ...) is unreachable from Fumie's picker even though the account can use it and
 * the API accepts the id verbatim. Rather than transcribe that list into Fumie —
 * where it would rot on the next SDK bump and lie about what the account can
 * actually reach — we read it back out of the binary we already ship.
 *
 * HOW: the executable is a Bun single-file bundle, so its JavaScript sits in the
 * file as plain (ASCII) text. Three structures are recovered by shape, never by
 * minified identifier — identifiers change on every build:
 *
 *  1. the catalog entries, `{id:"claude-opus-4-8",family:"opus",display_name:
 *     "Opus 4.8",...,context:{window:1e6,...},max_output_tokens:{default:64000,
 *     ...},capabilities:[...]}`;
 *  2. the id→slug map, `{"claude-opus-4-8":"opus48",...}`;
 *  3. the array of slugs the CLI is willing to offer, `["haiku45",...,"fable51"]`.
 *
 * (3) is what keeps unannounced and retired rows out of Fumie's picker: the
 * catalog also carries families the CLI never offers. It is required, not
 * optional — without it we cannot tell an offerable model from an internal one,
 * and publishing the whole catalog would put dead ids in front of the user. When
 * any of the three cannot be recovered the reader answers `undefined` and the
 * caller keeps the SDK-only catalog it had before.
 *
 * Other platforms' packages are the same Bun bundle for a different target, so
 * the embedded-text layout is identical; nothing here is darwin-specific. Every
 * failure mode is "return undefined", never a throw.
 */

/** One row of the CLI's baked catalog, reduced to what Fumie's picker needs. */
export interface IClaudeCliRegistryModel {
	/** Anthropic-canonical id, accepted verbatim by the API (`claude-opus-4-8`). */
	readonly id: string;
	/** `opus` / `sonnet` / `haiku` / `fable` — the catalog's own grouping. */
	readonly family: string;
	/** The CLI's own display name (`Opus 4.8`). */
	readonly displayName: string;
	/** Native context window, from the catalog's `context.window`. */
	readonly maxContextWindow?: number;
	/** Default output cap, from the catalog's `max_output_tokens.default`. */
	readonly maxOutputTokens?: number;
	/** Effort levels the catalog says this model accepts; empty for models with none. */
	readonly supportedEfforts: readonly ClaudeEffortLevel[];
}

export interface IClaudeCliModelRegistry {
	/** Catalog rows the CLI would offer, in catalog order. */
	readonly models: readonly IClaudeCliRegistryModel[];
}

/**
 * Canonical order of {@link ClaudeEffortLevel}; the CLI's own effort enum uses
 * exactly this sequence, so a row's levels are always a prefix-plus-extras of it.
 */
const EFFORT_ORDER: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Catalog `capabilities` entries that widen a model's effort range. The base
 * `effort` capability carries low/medium/high; the other two each add one level.
 * This decodes capability flags — it is not a per-model table.
 */
const EFFORT_CAPABILITIES: ReadonlyMap<string, readonly ClaudeEffortLevel[]> = new Map([
	['effort', ['low', 'medium', 'high'] as readonly ClaudeEffortLevel[]],
	['xhigh_effort', ['xhigh'] as readonly ClaudeEffortLevel[]],
	['max_effort', ['max'] as readonly ClaudeEffortLevel[]],
]);

/** Head of one catalog entry. The three leading fields are stable across builds. */
const ENTRY_HEAD_RE = /\{id:"(claude-[a-z0-9.-]{1,48})",family:"([a-z]{1,16})",display_name:"([^"]{1,48})"/g;

/** Upper bound on one entry's body; the widest real entry is well under half this. */
const MAX_ENTRY_BODY = 2048;

/** `{"claude-opus-4-8":"opus48",...}` — every key a model id, every value a slug. */
const SLUG_MAP_RE = /\{"claude-[a-z0-9.-]{1,48}":"[a-z0-9]{1,24}"(?:,"claude-[a-z0-9.-]{1,48}":"[a-z0-9]{1,24}"){2,}\}/g;

/**
 * Candidate slug array: at least six string literals shaped like a catalog slug
 * (letters then digits — `opus48`, `sonnet5`, `fable51`). Validated against the
 * recovered slug map before use, so a lookalike array cannot be mistaken for it.
 */
const SLUG_ARRAY_RE = /\["[a-z]{2,12}[0-9]{1,3}"(?:,"[a-z]{2,12}[0-9]{1,3}"){5,}\]/g;

/** Bound on retained slug-array candidates; the shape filter leaves far fewer. */
const MAX_SLUG_ARRAY_CANDIDATES = 64;

const CONTEXT_WINDOW_RE = /context:\{window:(\d+(?:\.\d+)?(?:e\+?\d+)?)/;
const MAX_OUTPUT_RE = /max_output_tokens:\{default:(\d+)/;
const CAPABILITIES_RE = /capabilities:\[([^\]]*)\]/;
const EFFORT_COST_INDEX_RE = /effort_cost_index:\{([^}]*)\}/;

/**
 * Accumulates the three structures across an arbitrary chunking of the binary.
 * They live megabytes apart, so nothing can assume they share a window — each is
 * collected independently and only reconciled in {@link finish}.
 */
class ClaudeCliRegistryScanner {

	private readonly _entries = new Map<string, IClaudeCliRegistryModel>();
	private _slugById: ReadonlyMap<string, string> | undefined;
	private _slugArrays: string[][] = [];

	/** True once every structure has been seen, so the reader can stop early. */
	get complete(): boolean {
		return this._entries.size > 0 && this._slugById !== undefined && this._slugArrays.length > 0;
	}

	push(chunk: string): void {
		this._pushEntries(chunk);
		this._pushSlugMap(chunk);
		this._pushSlugArrays(chunk);
	}

	finish(): IClaudeCliModelRegistry | undefined {
		const slugById = this._slugById;
		if (!slugById || this._entries.size === 0) {
			return undefined;
		}
		const knownSlugs = new Set(slugById.values());
		// The offerable-slug array is the one whose every element is a real slug;
		// among those, the longest (a shorter all-valid array would be a subset used
		// for something else, e.g. a migration list).
		let offerable: readonly string[] | undefined;
		for (const candidate of this._slugArrays) {
			if (candidate.every(slug => knownSlugs.has(slug)) && candidate.length > (offerable?.length ?? 0)) {
				offerable = candidate;
			}
		}
		if (!offerable) {
			return undefined;
		}
		const offerableIds = new Set<string>();
		for (const [id, slug] of slugById) {
			if (offerable.includes(slug)) {
				offerableIds.add(id);
			}
		}
		const models = [...this._entries.values()].filter(model => offerableIds.has(model.id));
		return models.length > 0 ? { models } : undefined;
	}

	private _pushEntries(chunk: string): void {
		ENTRY_HEAD_RE.lastIndex = 0;
		for (let head = ENTRY_HEAD_RE.exec(chunk); head; head = ENTRY_HEAD_RE.exec(chunk)) {
			const [matched, id, family, displayName] = head;
			const bodyStart = head.index + matched.length;
			let body = chunk.slice(bodyStart, bodyStart + MAX_ENTRY_BODY);
			// Entries are packed back to back; stop at the next one so a missing
			// field is read as missing rather than borrowed from its neighbour.
			const nextEntry = body.indexOf('{id:"claude-');
			if (nextEntry !== -1) {
				body = body.slice(0, nextEntry);
			}
			const maxContextWindow = parseNumberField(body, CONTEXT_WINDOW_RE);
			const maxOutputTokens = parseNumberField(body, MAX_OUTPUT_RE);
			const model: IClaudeCliRegistryModel = {
				id,
				family,
				displayName,
				...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
				supportedEfforts: parseSupportedEfforts(body),
			};
			// Chunk overlap re-reads entries, and the tail of a chunk can cut an
			// entry short. Keep whichever sighting carried more of the body.
			const existing = this._entries.get(id);
			if (!existing || completeness(model) > completeness(existing)) {
				this._entries.set(id, model);
			}
		}
	}

	private _pushSlugMap(chunk: string): void {
		SLUG_MAP_RE.lastIndex = 0;
		for (let match = SLUG_MAP_RE.exec(chunk); match; match = SLUG_MAP_RE.exec(chunk)) {
			const parsed = parseSlugMap(match[0]);
			// The CLI carries small id→slug objects for other purposes (feature
			// pairings, overrides); the catalog's own map is the largest.
			if (parsed && parsed.size > (this._slugById?.size ?? 0)) {
				this._slugById = parsed;
			}
		}
	}

	private _pushSlugArrays(chunk: string): void {
		SLUG_ARRAY_RE.lastIndex = 0;
		for (let match = SLUG_ARRAY_RE.exec(chunk); match && this._slugArrays.length < MAX_SLUG_ARRAY_CANDIDATES; match = SLUG_ARRAY_RE.exec(chunk)) {
			const slugs = [...match[0].matchAll(/"([^"]+)"/g)].map(m => m[1]);
			if (!this._slugArrays.some(existing => existing.length === slugs.length && existing.every((slug, i) => slug === slugs[i]))) {
				this._slugArrays.push(slugs);
			}
		}
	}
}

/** How much of an entry body a sighting managed to decode; used to break overlap ties. */
function completeness(model: IClaudeCliRegistryModel): number {
	return (model.maxContextWindow !== undefined ? 1 : 0)
		+ (model.maxOutputTokens !== undefined ? 1 : 0)
		+ (model.supportedEfforts.length > 0 ? 1 : 0);
}

function parseNumberField(body: string, pattern: RegExp): number | undefined {
	const match = pattern.exec(body);
	if (!match) {
		return undefined;
	}
	// The bundle minifies large literals to exponent form (`1e6`).
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The effort levels a catalog entry declares. `effort_cost_index` enumerates
 * them outright where it exists; older entries only carry the capability flags.
 */
function parseSupportedEfforts(body: string): readonly ClaudeEffortLevel[] {
	const levels = new Set<string>();
	const costIndex = EFFORT_COST_INDEX_RE.exec(body);
	if (costIndex) {
		for (const key of costIndex[1].matchAll(/([a-z]+):/g)) {
			levels.add(key[1]);
		}
	}
	const capabilities = CAPABILITIES_RE.exec(body);
	if (capabilities) {
		for (const capability of capabilities[1].matchAll(/"([^"]+)"/g)) {
			for (const level of EFFORT_CAPABILITIES.get(capability[1]) ?? []) {
				levels.add(level);
			}
		}
	}
	// A cost index without the base `effort` capability would be meaningless, so
	// require the capability side to have said "this model takes an effort" at all.
	if (!capabilities || !/"effort"/.test(capabilities[1])) {
		return [];
	}
	return EFFORT_ORDER.filter(level => levels.has(level));
}

function parseSlugMap(literal: string): ReadonlyMap<string, string> | undefined {
	const entries = new Map<string, string>();
	for (const pair of literal.matchAll(/"(claude-[a-z0-9.-]+)":"([a-z0-9]+)"/g)) {
		entries.set(pair[1], pair[2]);
	}
	return entries.size > 0 ? entries : undefined;
}

/**
 * Parse an already-in-memory slice of the bundle. Exported for tests and used by
 * {@link readClaudeCliModelRegistry} for the streaming case.
 */
export function parseClaudeCliModelRegistry(text: string): IClaudeCliModelRegistry | undefined {
	const scanner = new ClaudeCliRegistryScanner();
	scanner.push(text);
	return scanner.finish();
}

/** 4 MiB working window; the overlap must exceed the widest structure we match. */
const CHUNK_BYTES = 4 << 20;
const OVERLAP_BYTES = 64 << 10;

/**
 * Cache keyed by identity-on-disk, so an SDK upgrade (new size / mtime) re-reads
 * while repeated model refreshes in one agent-host process do not. `undefined`
 * results are cached too: a binary we could not parse will not parse on the
 * second try either, and re-scanning ~200 MB to rediscover that is the exact
 * cost this cache exists to avoid.
 */
const registryCache = new Map<string, IClaudeCliModelRegistry | undefined>();

/**
 * Stream the CLI executable and recover its baked model catalog.
 *
 * Never throws: a missing, unreadable, or unrecognized binary answers
 * `undefined`, which callers treat as "no extra rows".
 */
export async function readClaudeCliModelRegistry(executablePath: string): Promise<IClaudeCliModelRegistry | undefined> {
	let cacheKey: string;
	let handle;
	try {
		handle = await open(executablePath, 'r');
	} catch {
		return undefined;
	}
	try {
		const stat = await handle.stat();
		cacheKey = `${executablePath}\u0000${stat.size}\u0000${stat.mtimeMs}`;
		if (registryCache.has(cacheKey)) {
			return registryCache.get(cacheKey);
		}
		const scanner = new ClaudeCliRegistryScanner();
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let position = 0;
		while (position < stat.size) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
			if (bytesRead === 0) {
				break;
			}
			// `latin1` is a byte-per-character decode: the structures we match are
			// ASCII, and no multi-byte sequence elsewhere in the binary can be
			// mis-joined into one.
			scanner.push(buffer.toString('latin1', 0, bytesRead));
			if (scanner.complete) {
				break;
			}
			position += Math.max(bytesRead - OVERLAP_BYTES, 1);
		}
		const registry = scanner.finish();
		registryCache.set(cacheKey, registry);
		return registry;
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => { /* best effort */ });
	}
}
