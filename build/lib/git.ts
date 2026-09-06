/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import fs from 'fs';

/**
 * Resolves `<repo>/.git` to the git directory of this checkout and to the common
 * directory shared with the main checkout. In a worktree (or a submodule) `.git`
 * is a file holding `gitdir: <path>`; HEAD lives in that directory while
 * `refs/` and `packed-refs` normally live in the common directory it names.
 * Reading `<repo>/.git/HEAD` blindly makes every worktree build ship a null
 * commit.
 */
function resolveGitDirs(repo: string): { gitDir: string; commonDir: string } | undefined {
	const git = path.join(repo, '.git');
	let stat: fs.Stats;

	try {
		stat = fs.statSync(git);
	} catch (e) {
		return undefined;
	}

	if (stat.isDirectory()) {
		return { gitDir: git, commonDir: git };
	}

	let gitDirMatch: RegExpExecArray | null;

	try {
		gitDirMatch = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
	} catch (e) {
		return undefined;
	}

	if (!gitDirMatch) {
		return undefined;
	}

	const gitDir = path.resolve(repo, gitDirMatch[1].trim());
	let commonDir = gitDir;

	try {
		commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
	} catch (e) {
		// noop: a plain `gitdir:` link without a common directory
	}

	return { gitDir, commonDir };
}

/**
 * Returns the sha1 commit version of a repository or undefined in case of failure.
 */
export function getVersion(repo: string): string | undefined {
	const dirs = resolveGitDirs(repo);

	if (!dirs) {
		return undefined;
	}

	const { gitDir, commonDir } = dirs;
	const headPath = path.join(gitDir, 'HEAD');
	let head: string;

	try {
		head = fs.readFileSync(headPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	if (/^[0-9a-f]{40}$/i.test(head)) {
		return head;
	}

	const refMatch = /^ref: (.*)$/.exec(head);

	if (!refMatch) {
		return undefined;
	}

	const ref = refMatch[1];

	for (const base of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
		try {
			const value = fs.readFileSync(path.join(base, ref), 'utf8').trim();
			if (/^[0-9a-f]{40}$/i.test(value)) {
				return value;
			}
		} catch (e) {
			// noop
		}
	}

	const packedRefsPath = path.join(commonDir, 'packed-refs');
	let refsRaw: string;

	try {
		refsRaw = fs.readFileSync(packedRefsPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	const refsRegex = /^([0-9a-f]{40})\s+(.+)$/gm;
	let refsMatch: RegExpExecArray | null;
	const refs: { [ref: string]: string } = {};

	while (refsMatch = refsRegex.exec(refsRaw)) {
		refs[refsMatch[2]] = refsMatch[1];
	}

	return refs[ref];
}
