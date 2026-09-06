/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/**
 * Returns `true` when a session spans more than one effective working
 * directory (a *multi-root* session), and `false` otherwise — including when
 * the session has no working directories or exactly one.
 *
 * Callers pass the ordered set returned by
 * `IAgentConfigurationService.getEffectiveWorkingDirectories(session)` (index 0
 * is the primary). Multi-root change-reporting behavior is gated on this
 * predicate, so single-root and empty sessions keep their existing behavior.
 */
export function isMultiRootSession(workingDirectories: readonly string[] | undefined): boolean {
	return (workingDirectories?.length ?? 0) > 1;
}

/**
 * `_meta` key on a `completions` request that carries the working directories
 * the completion should be computed against, as URI strings.
 *
 * A composer draft in the Agents window is client-local: no session exists on
 * the host until the first message is sent, so there is no session state to
 * read `workingDirectories` from. The client puts them on the request's
 * sanctioned `_meta` slot instead. Receivers that do not understand the key
 * ignore it, and providers prefer real session state whenever it exists.
 */
export const AH_META_COMPLETIONS_WORKING_DIRECTORIES = 'vscode.chat.workingDirectories';

/**
 * Reads {@link AH_META_COMPLETIONS_WORKING_DIRECTORIES} out of a request's
 * `_meta` bag. Returns `undefined` when the key is absent, is not an array, or
 * carries no usable URI string.
 */
export function readCompletionsWorkingDirectoriesMeta(meta: Record<string, unknown> | undefined): string[] | undefined {
	const value = meta?.[AH_META_COMPLETIONS_WORKING_DIRECTORIES];
	if (!Array.isArray(value)) {
		return undefined;
	}
	const workingDirectories = value.filter((entry): entry is string => typeof entry === 'string');
	return workingDirectories.length > 0 ? workingDirectories : undefined;
}

/**
 * Finds the deepest working directory that contains `resource`.
 */
export function findDeepestContainingWorkingDirectory(resource: URI, workingDirectories: readonly URI[]): URI | undefined {
	let deepestMatch: URI | undefined;
	for (const workingDirectory of workingDirectories) {
		if (extUriBiasedIgnorePathCase.isEqualOrParent(resource, workingDirectory) && (!deepestMatch || workingDirectory.path.length > deepestMatch.path.length)) {
			deepestMatch = workingDirectory;
		}
	}
	return deepestMatch;
}
