/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../base/common/network.js';
import { hasKey } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';

/**
 * Commands that ask a question about a path rather than assert it exists:
 * reading an optional config file, stat-ing it, and starting a watch on a
 * path the user may create later. Opening a session runs all three over the
 * workspace root for `.mcp.json`, `.claude/settings.json` and
 * `.github/copilot/settings.json`, none of which most repositories have.
 *
 * The protocol still answers `NotFound` (-32008) — that is what the spec
 * requires of these commands, and the error still reaches the caller, which
 * decides whether the absence matters. What it must not do is enter either
 * endpoint's log as a failed request.
 *
 * For `createResourceWatch` the caller that decides is
 * {@link AHPFileSystemProvider.watch} in `agentHostFileSystemProvider.ts`:
 * a `NotFound` there means "not created yet", so it watches the closest
 * existing ancestor until the path appears.
 */
const PROBE_METHODS: ReadonlySet<string> = new Set([
	'resourceRead',
	'resourceResolve',
	'createResourceWatch',
]);

export function isFileResourceProbe(method: string, params: unknown): boolean {
	if (!PROBE_METHODS.has(method) || !hasUriParam(params)) {
		return false;
	}
	const uri = params.uri;
	if (typeof uri !== 'string') {
		return false;
	}
	try {
		return URI.parse(uri).scheme === Schemas.file;
	} catch {
		return false;
	}
}

function hasUriParam(params: unknown): params is { readonly uri: unknown } {
	return typeof params === 'object' && params !== null && hasKey(params, { uri: true });
}
