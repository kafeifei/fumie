/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';

/** Where the pairing lives, under this installation's `FUMIE_HOME`. */
export const MOBILE_WEB_PAIRING_FILE = 'fumie-mobile-web-pairing.json';

/** Enough to find one dev tunnel again: the pair of ids its API addresses it by. */
export interface IMobileWebTunnelRef {
	readonly tunnelId: string;
	readonly clusterId: string;
}

/**
 * The three things that decide what a phone's address looks like, remembered
 * so it is the same address on the next run.
 *
 * Every one of them used to be picked afresh per process — the capability from
 * `crypto.randomBytes`, the port from `listen(0)`, the tunnel from a fresh
 * `createTunnel` — which is why the user had to copy a new URL onto the phone
 * after every restart. Writing them down is the whole of the fix; nothing here
 * widens what the address grants.
 */
export interface IMobileWebPairing {
	/**
	 * The capability in `/m/<secret>` and in the `fumie_mobile` cookie. Never
	 * logged, never put in a tunnel label, never derived from anything public.
	 */
	readonly secret: string;
	readonly port: number;
	/**
	 * The dev tunnel the address lives on, once one exists.
	 *
	 * This used to be a `tunnelName` that a run asked the service to create the
	 * tunnel under, on the theory that a fixed name fixes the hostname. It does
	 * not, for a personal GitHub account: the service refuses the name outright
	 * and every run fell back to a service-assigned one —
	 *
	 *     Tunnel service error: Request forbidden. The allow custom tunnel
	 *     names feature is disabled.
	 *
	 * — so the hostname moved on every restart anyway. What is actually stable
	 * is the tunnel itself. Remembering which one it is, and reconnecting to it
	 * instead of deleting and recreating, keeps the service's own random name
	 * for as long as the tunnel lives. Absent until the first tunnel comes up,
	 * and cleared by {@link rollMobileWebPairing}.
	 */
	readonly tunnel?: IMobileWebTunnelRef;
}

/**
 * The range a pairing's port is drawn from, once, at pairing creation.
 *
 * Deliberately *not* whatever `listen(0)` handed out on the first run. That
 * number comes from the OS's ephemeral range, which the OS is entitled to hand
 * to anything else the moment this process lets go of it — persisting one
 * means coming back next launch to a port that is now somebody's outbound
 * socket. This range sits above the registered ports and below macOS's
 * ephemeral range (49152+); Linux's default range starts lower (32768) and can
 * still overlap, which is why binding a pinned port is allowed to fail out
 * loud rather than assumed to work.
 */
const PAIRING_PORT_FIRST = 39000;
const PAIRING_PORT_LAST = 45999;

/**
 * Read a pairing, or `undefined` for anything that is not one.
 *
 * Half a pairing is worth nothing where the *address* is concerned: a file that
 * has been truncated, hand-edited or written by an older shape must be replaced
 * rather than half-used, because a port out of range produces an address that
 * cannot be served, which is a worse failure than starting over.
 *
 * The tunnel reference is held to a softer rule on purpose. It is a pointer to
 * something the service owns, not a half of the address: losing it costs one
 * new tunnel and a moved hostname, while throwing the whole pairing away over
 * it would additionally kill every URL and cookie already on a phone. So a
 * reference that is not whole is dropped and the rest of the pairing kept. An
 * older file's `tunnelName` is ignored for the same reason — see
 * {@link IMobileWebPairing.tunnel} for why that field stopped meaning anything.
 */
export function parseMobileWebPairing(raw: string): IMobileWebPairing | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const { secret, port, tunnel } = parsed as Record<string, unknown>;
	if (typeof secret !== 'string' || !secret) {
		return undefined;
	}
	if (typeof port !== 'number' || !Number.isInteger(port) || port < PAIRING_PORT_FIRST || port > PAIRING_PORT_LAST) {
		return undefined;
	}
	const reference = parseMobileWebTunnelRef(tunnel);
	return reference ? { secret, port, tunnel: reference } : { secret, port };
}

/** The tunnel half of a pairing, or `undefined` for anything that could not address a tunnel. */
function parseMobileWebTunnelRef(value: unknown): IMobileWebTunnelRef | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { tunnelId, clusterId } = value as Record<string, unknown>;
	return typeof tunnelId === 'string' && tunnelId && typeof clusterId === 'string' && clusterId
		? { tunnelId, clusterId }
		: undefined;
}

/**
 * A brand new pairing. Nothing in it is derived from anything else in it.
 *
 * It carries no tunnel: the first run to bring one up records it, and every run
 * after that reconnects to the one already recorded.
 */
export function createMobileWebPairing(): IMobileWebPairing {
	return {
		secret: randomBytes(16).toString('base64url'),
		port: randomInt(PAIRING_PORT_FIRST, PAIRING_PORT_LAST + 1),
	};
}

/** The pairing this installation hands a phone, creating one on first use. */
export async function readOrCreateMobileWebPairing(directory: string): Promise<IMobileWebPairing> {
	const existing = await readMobileWebPairing(directory);
	if (existing) {
		return existing;
	}
	const created = createMobileWebPairing();
	await writeMobileWebPairing(directory, created);
	return created;
}

/** What a reset left behind for the caller to finish. */
export interface IRolledMobileWebPairing {
	readonly pairing: IMobileWebPairing;
	/**
	 * The tunnel the old address lived on, now unreferenced.
	 *
	 * Handed back rather than deleted here because deleting one takes an
	 * authenticated management client, which this module has no business
	 * holding. The caller deletes it if it can; if it cannot, the tunnel is no
	 * longer the pairing's and gets cleaned up as a leftover instead.
	 */
	readonly releasedTunnel?: IMobileWebTunnelRef;
}

/**
 * Take back every address handed out so far.
 *
 * The secret goes, because it is what every old link and every old
 * `fumie_mobile` cookie carries. The tunnel goes with it: the hostname is the
 * other half of what the user pasted onto a phone, and a reset that left the
 * old host answering — even at a dead path — would be a reset only on paper.
 * The port stays, since it is not something anyone was handed on its own.
 */
export async function rollMobileWebPairing(directory: string): Promise<IRolledMobileWebPairing> {
	const existing = await readMobileWebPairing(directory);
	const rolled: IMobileWebPairing = {
		secret: randomBytes(16).toString('base64url'),
		port: existing?.port ?? createMobileWebPairing().port,
	};
	await writeMobileWebPairing(directory, rolled);
	return { pairing: rolled, releasedTunnel: existing?.tunnel };
}

/**
 * Note which tunnel this pairing's address now lives on, so the next run
 * reconnects to it instead of creating one and moving the hostname.
 */
export async function rememberMobileWebTunnel(directory: string, pairing: IMobileWebPairing, tunnel: IMobileWebTunnelRef): Promise<void> {
	await writeMobileWebPairing(directory, { ...pairing, tunnel });
}

/** Drop the tunnel reference, leaving the rest of the pairing — and the local address — alone. */
export async function forgetMobileWebTunnel(directory: string, pairing: IMobileWebPairing): Promise<void> {
	await writeMobileWebPairing(directory, { secret: pairing.secret, port: pairing.port });
}

async function readMobileWebPairing(directory: string): Promise<IMobileWebPairing | undefined> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(path.join(directory, MOBILE_WEB_PAIRING_FILE), 'utf8');
	} catch {
		return undefined; // No pairing yet, which is the first-run case.
	}
	return parseMobileWebPairing(raw);
}

/**
 * Write the pairing by renaming a fresh mode-`0600` file over the old one, the
 * way `localAgentHostMetadata.ts` publishes an endpoint entry: a reader that
 * arrives mid-write sees the previous whole pairing rather than half of the new
 * one.
 */
async function writeMobileWebPairing(directory: string, pairing: IMobileWebPairing): Promise<void> {
	await prepareOwnerOnlyDirectory(directory);
	const target = path.join(directory, MOBILE_WEB_PAIRING_FILE);
	const temporaryPath = `${target}.${randomBytes(16).toString('hex')}.tmp`;
	const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify(pairing), 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.promises.rename(temporaryPath, target);
	} finally {
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => { /* best effort */ });
	}
}

/**
 * `FUMIE_HOME` itself, owner-only.
 *
 * The secret below is a credential in the same sense as the agent host's
 * connection tokens, which already live under this directory behind the same
 * treatment (`prepareOwnerOnlyDirectory` in `localAgentHostMetadata.ts`). A
 * mode-`0600` file inside a world-readable directory is only half the answer.
 */
async function prepareOwnerOnlyDirectory(directory: string): Promise<void> {
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== 'win32') {
		await fs.promises.chmod(directory, 0o700);
	}
}
