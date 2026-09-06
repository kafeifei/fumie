/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { isLinux } from '../../../../base/common/platform.js';
import { basename, normalizePath, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

const REPOSITORY_HASH_LENGTH = 12;
const SESSION_HASH_LENGTH = 8;
const MAX_REPOSITORY_LABEL_LENGTH = 64;
const MAX_SESSION_LABEL_LENGTH = 80;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Returns Fumie's root for managed worktree checkouts. */
export function getManagedWorktreesRoot(fumieHome: URI): URI {
	return URI.joinPath(fumieHome, 'worktrees');
}

/** Returns the directory containing every managed checkout for a repository. */
export function getManagedWorktreeRepositoryRoot(fumieHome: URI, repositoryRoot: URI): URI {
	const canonicalRepositoryRoot = canonicalizeRepositoryRoot(repositoryRoot);
	const repositoryHash = shortHash(canonicalRepositoryRoot.toString(), REPOSITORY_HASH_LENGTH);
	const repositoryLabel = sanitizeRepositoryLabel(basename(canonicalRepositoryRoot));
	return URI.joinPath(getManagedWorktreesRoot(fumieHome), `${repositoryLabel}-${repositoryHash}`);
}

/** Returns the managed checkout path for a session in a repository. */
export function getManagedWorktreePath(fumieHome: URI, repositoryRoot: URI, sessionId: string): URI {
	return URI.joinPath(
		getManagedWorktreeRepositoryRoot(fumieHome, repositoryRoot),
		sanitizeWorktreeSessionId(sessionId),
	);
}

/**
 * Converts an arbitrary session id into one safe path segment. Already-safe
 * ids remain unchanged; transformed ids retain a readable prefix and gain a
 * short hash so distinct ids do not collapse onto the same checkout.
 */
export function sanitizeWorktreeSessionId(sessionId: string): string {
	const readable = sessionId
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[.-]+|[. -]+$/g, '')
		.slice(0, MAX_SESSION_LABEL_LENGTH);
	const isAlreadySafe = readable === sessionId
		&& readable.length > 0
		&& !WINDOWS_RESERVED_BASENAME.test(readable);
	if (isAlreadySafe) {
		return readable;
	}

	const safeReadable = readable && !WINDOWS_RESERVED_BASENAME.test(readable)
		? readable
		: readable ? `session-${readable}` : 'session';
	return `${safeReadable}-${shortHash(sessionId, SESSION_HASH_LENGTH)}`;
}

function canonicalizeRepositoryRoot(repositoryRoot: URI): URI {
	const scheme = repositoryRoot.scheme.toLowerCase();
	const normalized = normalizePath(repositoryRoot.with({
		scheme,
		authority: repositoryRoot.authority.toLowerCase(),
		query: null,
		fragment: null,
	}));
	const withoutTrailingSeparator = removeTrailingPathSeparator(normalized);

	// Match the local filesystem's canonical comparison rule. Linux paths are
	// case-sensitive; the other supported local platforms compare file paths
	// case-insensitively for stable repository identity.
	return scheme === 'file' && !isLinux
		? withoutTrailingSeparator.with({ path: withoutTrailingSeparator.path.toLowerCase() })
		: withoutTrailingSeparator;
}

function sanitizeRepositoryLabel(repositoryName: string): string {
	const readable = repositoryName
		.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[. -]+|[. -]+$/g, '')
		.slice(0, MAX_REPOSITORY_LABEL_LENGTH);
	if (!readable) {
		return 'repository';
	}
	return WINDOWS_RESERVED_BASENAME.test(readable) ? `repository-${readable}` : readable;
}

function shortHash(value: string, length: number): string {
	return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}
