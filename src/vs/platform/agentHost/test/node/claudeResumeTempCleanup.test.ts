/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { cleanupOrphanedClaudeResumeDirs } from '../../node/claude/claudeResumeTempCleanup.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

suite('claudeResumeTempCleanup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let tmpDir: string;

	setup(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-resume-gc-test-'));
	});

	teardown(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Stamp every file and directory under `root` (deepest first) with `mtimeMs`. */
	function backdate(root: string, mtimeMs: number): void {
		const stack: string[] = [];
		const visit = (dir: string) => {
			stack.push(dir);
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const child = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					visit(child);
				} else {
					fs.utimesSync(child, mtimeMs / 1000, mtimeMs / 1000);
				}
			}
		};
		visit(root);
		// Parents last: touching a child rewrites its directory's mtime.
		for (const dir of stack.reverse()) {
			fs.utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
		}
	}

	/**
	 * A directory shaped like one the SDK materializes for a store-backed
	 * resume, backdated so the whole tree looks `ageMs` old.
	 */
	function makeResumeDir(name: string, ageMs: number, extraEntries: readonly string[] = []): string {
		const dir = path.join(tmpDir, name);
		fs.mkdirSync(path.join(dir, 'projects', '-Users-someone-repo'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'projects', '-Users-someone-repo', `${generateUuid()}.jsonl`), '{}\n');
		fs.writeFileSync(path.join(dir, '.claude.json'), '{}');
		fs.mkdirSync(path.join(dir, 'shell-snapshots'));
		for (const extra of extraEntries) {
			fs.writeFileSync(path.join(dir, extra), 'x');
		}
		backdate(dir, Date.now() - ageMs);
		return dir;
	}

	function names(dir: string): string[] {
		return fs.readdirSync(dir).sort();
	}

	async function run(): Promise<Awaited<ReturnType<typeof cleanupOrphanedClaudeResumeDirs>>> {
		return cleanupOrphanedClaudeResumeDirs(new NullLogService(), { tmpDir });
	}

	test('removes a well-formed resume dir nothing has touched for a day', async () => {
		const stale = `claude-resume-${generateUuid()}`;
		makeResumeDir(stale, 2 * DAY);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, left: names(tmpDir) }, { removed: [stale], left: [] });
	});

	test('keeps a dir whose only recent write is deep inside the transcript tree', async () => {
		// A busy session appends to `projects/<key>/<session>.jsonl`, which
		// touches the file and nothing above it — so the root looks ancient
		// while the session is very much alive. Deleting it would take the
		// config dir out from under a running subprocess.
		const live = `claude-resume-${generateUuid()}`;
		const dir = makeResumeDir(live, 2 * DAY);
		const transcript = path.join(dir, 'projects', '-Users-someone-repo', fs.readdirSync(path.join(dir, 'projects', '-Users-someone-repo'))[0]);
		fs.utimesSync(transcript, Date.now() / 1000, Date.now() / 1000);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, keptRecent: result.keptRecent, left: names(tmpDir) }, { removed: [], keptRecent: 1, left: [live] });
	});

	test('keeps a dir that was written to within the window', async () => {
		const recent = `claude-resume-${generateUuid()}`;
		makeResumeDir(recent, 1 * HOUR);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, keptRecent: result.keptRecent, left: names(tmpDir) }, { removed: [], keptRecent: 1, left: [recent] });
	});

	test('keeps a stale dir holding content it does not recognize', async () => {
		const foreign = `claude-resume-${generateUuid()}`;
		makeResumeDir(foreign, 2 * DAY, ['something-we-do-not-write']);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, keptUnrecognized: result.keptUnrecognized, left: names(tmpDir) }, { removed: [], keptUnrecognized: 1, left: [foreign] });
	});

	test('keeps a stale dir holding a directory it does not recognize', async () => {
		const foreign = `claude-resume-${generateUuid()}`;
		const dir = makeResumeDir(foreign, 2 * DAY);
		fs.mkdirSync(path.join(dir, 'someone-elses-tree'));
		backdate(dir, Date.now() - 2 * DAY);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, keptUnrecognized: result.keptUnrecognized, left: names(tmpDir) }, { removed: [], keptUnrecognized: 1, left: [foreign] });
	});

	test('a CLI json cache the allowlist has never heard of does not block the sweep', async () => {
		// The CLI keeps adding caches next to `.claude.json`
		// (`mcp-needs-auth-cache.json` is one). Enumerating them by name would
		// silently switch this sweep off the next time it grows another — the
		// leak is only visible as temp filling up, so nobody would notice.
		const stale = `claude-resume-${generateUuid()}`;
		makeResumeDir(stale, 2 * DAY, ['mcp-needs-auth-cache.json', 'some-future-cache.json']);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, left: names(tmpDir) }, { removed: [stale], left: [] });
	});

	test('keeps a stale dir with no projects/ — the one thing the SDK always writes', async () => {
		const notOurs = path.join(tmpDir, `claude-resume-${generateUuid()}`);
		fs.mkdirSync(notOurs);
		fs.writeFileSync(path.join(notOurs, '.claude.json'), '{}');
		backdate(notOurs, Date.now() - 2 * DAY);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, keptUnrecognized: result.keptUnrecognized, left: names(tmpDir).length }, { removed: [], keptUnrecognized: 1, left: 1 });
	});

	test('keeps a stale claude-resume-* dir whose name is not the SDK uuid form', async () => {
		makeResumeDir('claude-resume-not-a-uuid', 2 * DAY);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, keptUnrecognized: result.keptUnrecognized, left: names(tmpDir) }, { removed: [], keptUnrecognized: 1, left: ['claude-resume-not-a-uuid'] });
	});

	test('never touches unrelated temp entries', async () => {
		fs.mkdirSync(path.join(tmpDir, 'some-other-tool'));
		fs.writeFileSync(path.join(tmpDir, 'claude-resume-lookalike.txt'), 'x');
		backdate(tmpDir, Date.now() - 2 * DAY);

		const result = await run();

		assert.deepStrictEqual({ removed: result.removed, left: names(tmpDir) }, { removed: [], left: ['claude-resume-lookalike.txt', 'some-other-tool'] });
	});

	test('an unreadable temp dir degrades to a no-op instead of throwing', async () => {
		const result = await cleanupOrphanedClaudeResumeDirs(new NullLogService(), { tmpDir: path.join(tmpDir, 'does-not-exist') });
		assert.deepStrictEqual(result.removed, []);
	});
});
