/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	createMobileWebPairing,
	forgetMobileWebTunnel,
	MOBILE_WEB_PAIRING_FILE,
	parseMobileWebPairing,
	readOrCreateMobileWebPairing,
	rememberMobileWebTunnel,
	rollMobileWebPairing,
} from '../../node/fumie/mobileWebPairing.js';

/** The range `mobileWebPairing.ts` draws a port from, restated so a change to it has to be deliberate. */
const PORT_FIRST = 39000;
const PORT_LAST = 45999;

suite('mobile web pairing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let directory: string;

	setup(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-mobile-pairing-test-'));
	});

	teardown(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function pairingPath(): string {
		return path.join(directory, MOBILE_WEB_PAIRING_FILE);
	}

	test('reads back the pairing a previous run wrote, which is the whole point of writing it', () => {
		const written = { secret: 'a-secret', port: 40123, tunnel: { tunnelId: 'abc', clusterId: 'usw3' } };
		assert.deepStrictEqual(parseMobileWebPairing(JSON.stringify(written)), written);
	});

	/**
	 * Same rule as `parseMobileWebTunnelRecord`, for the half that *is* the
	 * address: a port outside the range cannot produce a servable address, so
	 * it must be replaced rather than half-used.
	 */
	test('refuses anything that is not a whole pairing', () => {
		for (const raw of [
			'',
			'not json',
			'[]',
			'null',
			'"abc"',
			'{}',
			'{"port":40000}',
			'{"secret":"","port":40000}',
			'{"secret":"a"}',
			'{"secret":"a","port":"40000"}',
			'{"secret":"a","port":40000.5}',
			'{"secret":"a","port":80}',
			'{"secret":"a","port":60000}',
			// A truncated write, which is what a crash mid-file leaves behind.
			'{"secret":"a","port":400',
		]) {
			assert.strictEqual(parseMobileWebPairing(raw), undefined, raw);
		}
	});

	/**
	 * A pairing written before the tunnel was remembered — and one written
	 * before this field existed at all, when it was a `tunnelName` the service
	 * turned out to forbid. Both still carry a working secret and port, and
	 * both must keep them: rejecting the file would kill every URL and cookie
	 * already on a phone in order to fix a field that only costs a new tunnel.
	 */
	test('keeps a pairing whose tunnel reference is missing, stale-shaped or unusable', () => {
		for (const raw of [
			'{"secret":"a","port":40000}',
			'{"secret":"a","port":40000,"tunnelName":"fumie-abc0123456"}',
			'{"secret":"a","port":40000,"tunnel":null}',
			'{"secret":"a","port":40000,"tunnel":{}}',
			'{"secret":"a","port":40000,"tunnel":{"tunnelId":"abc"}}',
			'{"secret":"a","port":40000,"tunnel":{"clusterId":"usw3"}}',
			'{"secret":"a","port":40000,"tunnel":{"tunnelId":"","clusterId":"usw3"}}',
			'{"secret":"a","port":40000,"tunnel":{"tunnelId":1,"clusterId":"usw3"}}',
		]) {
			assert.deepStrictEqual(parseMobileWebPairing(raw), { secret: 'a', port: 40000 }, raw);
		}
	});

	/**
	 * The port is chosen once and remembered, and deliberately not the one
	 * `listen(0)` handed out: the OS is entitled to hand an ephemeral port to
	 * anything else the moment this process lets go of it.
	 */
	test('a fresh pairing draws its port from the range it can keep', () => {
		for (let i = 0; i < 200; i++) {
			const { port } = createMobileWebPairing();
			assert.ok(Number.isInteger(port) && port >= PORT_FIRST && port <= PORT_LAST, `port out of range: ${port}`);
		}
	});

	/**
	 * A fresh pairing names no tunnel. Asking the service to create one under a
	 * name of our choosing is what this used to do, and a personal GitHub
	 * account is refused outright — `The allow custom tunnel names feature is
	 * disabled` — so the hostname came from the service every time anyway. The
	 * first start records whichever tunnel it got.
	 */
	test('a fresh pairing names no tunnel, because naming one is not ours to do', () => {
		for (let i = 0; i < 20; i++) {
			assert.strictEqual(createMobileWebPairing().tunnel, undefined);
		}
	});

	test('creates a pairing on first use and hands back the same one afterwards', async () => {
		const created = await readOrCreateMobileWebPairing(directory);
		assert.ok(fs.existsSync(pairingPath()));

		const again = await readOrCreateMobileWebPairing(directory);
		assert.deepStrictEqual(again, created, 'the address must not move between two reads of one pairing');
	});

	/**
	 * The bug this guards: a half-written or hand-edited file taken at face
	 * value produces a port that cannot be bound — a worse outcome than
	 * starting over, and one the user cannot diagnose.
	 */
	test('replaces a pairing it cannot read whole, rather than using half of one', async () => {
		const created = await readOrCreateMobileWebPairing(directory);
		fs.writeFileSync(pairingPath(), JSON.stringify(created).slice(0, 20));

		const replaced = await readOrCreateMobileWebPairing(directory);
		assert.notStrictEqual(replaced.secret, created.secret);
		assert.deepStrictEqual(parseMobileWebPairing(fs.readFileSync(pairingPath(), 'utf8')), replaced);
	});

	/**
	 * The tunnel a start comes up on is written back so the next start can
	 * reconnect to it. Without this the hostname is a fresh one every launch,
	 * which is the bug the whole pairing exists to fix.
	 */
	test('remembers the tunnel a start came up on, and hands it to the next read', async () => {
		const created = await readOrCreateMobileWebPairing(directory);
		await rememberMobileWebTunnel(directory, created, { tunnelId: 'abc', clusterId: 'usw3' });

		const reread = await readOrCreateMobileWebPairing(directory);
		assert.deepStrictEqual(reread, { ...created, tunnel: { tunnelId: 'abc', clusterId: 'usw3' } });

		await forgetMobileWebTunnel(directory, reread);
		assert.deepStrictEqual(await readOrCreateMobileWebPairing(directory), created);
	});

	/**
	 * Rolling replaces the secret and gives up the tunnel. The secret is what
	 * every issued URL and every stored cookie carries, but the hostname is the
	 * other half of what was pasted onto a phone and it now persists by design
	 * — so a reset that kept it would leave the old host answering. The port
	 * stays: nobody was handed it on its own.
	 */
	test('rolling replaces the secret and releases the tunnel the old address used', async () => {
		const created = await readOrCreateMobileWebPairing(directory);
		await rememberMobileWebTunnel(directory, created, { tunnelId: 'abc', clusterId: 'usw3' });
		const before = await readOrCreateMobileWebPairing(directory);

		const { pairing: after, releasedTunnel } = await rollMobileWebPairing(directory);

		assert.notStrictEqual(after.secret, before.secret);
		assert.strictEqual(after.port, before.port);
		assert.strictEqual(after.tunnel, undefined, 'a reset that kept the host is a reset only on paper');
		assert.deepStrictEqual(releasedTunnel, { tunnelId: 'abc', clusterId: 'usw3' }, 'the caller has to be told what to delete');
		assert.deepStrictEqual(await readOrCreateMobileWebPairing(directory), after);
	});

	test('rolling with no pairing on disk writes one, so the control works while sharing is off', async () => {
		const { pairing, releasedTunnel } = await rollMobileWebPairing(directory);
		assert.strictEqual(releasedTunnel, undefined);
		assert.deepStrictEqual(await readOrCreateMobileWebPairing(directory), pairing);
	});

	/**
	 * The secret is a credential in the same sense as the agent host's
	 * connection tokens, which already get this treatment in
	 * `localAgentHostMetadata.ts`. A 0600 file inside a world-readable
	 * directory is only half the answer, so both are checked.
	 */
	test('the pairing is written owner-only, file and directory both', async function () {
		if (process.platform === 'win32') {
			return; // POSIX modes mean nothing here; the directory carries an ACL instead.
		}
		// `mkdtemp` already makes an owner-only directory, so loosening it first
		// is what makes this a test of the writer rather than of the fixture.
		fs.chmodSync(directory, 0o755);
		await readOrCreateMobileWebPairing(directory);

		assert.strictEqual(fs.statSync(pairingPath()).mode & 0o777, 0o600);
		assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
	});

	test('leaves no temporary file behind, which would be a second copy of the secret', async () => {
		await readOrCreateMobileWebPairing(directory);
		await rollMobileWebPairing(directory);

		assert.deepStrictEqual(fs.readdirSync(directory), [MOBILE_WEB_PAIRING_FILE]);
	});
});
