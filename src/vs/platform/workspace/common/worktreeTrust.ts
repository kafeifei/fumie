/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IWorkspaceTrustManagementService } from './workspaceTrust.js';

/**
 * A git worktree checkout paired with the repository it was created from.
 */
export interface IWorktreeTrustCandidate {
	/** The worktree's checkout directory — the folder that will be worked in. */
	readonly worktree: URI;
	/** Root of the repository the worktree was created from. */
	readonly baseRepository: URI;
}

/**
 * Auto-trusts git worktrees whose base repository the user already trusts.
 *
 * A managed worktree lives outside the repository it was created from
 * (`~/.fumie/worktrees/...`), so ancestor-based workspace trust never covers
 * it — without this, working in a worktree would prompt for trust even though
 * the repository it was created from is already trusted.
 *
 * Trust is only ever *inherited*: a worktree of an untrusted repository is left
 * untrusted so it still has to pass an explicit trust prompt, and trust never
 * flows out of an untrusted repository. Callers must only pass folders they
 * know to be worktrees of the paired repository — a plain folder must never be
 * trusted through this path.
 *
 * Returns the worktrees that were newly trusted (empty when nothing changed),
 * so callers can tell whether a trust prompt is still required.
 */
export async function trustWorktreesOfTrustedRepositories(workspaceTrustManagementService: IWorkspaceTrustManagementService, candidates: readonly IWorktreeTrustCandidate[]): Promise<readonly URI[]> {
	if (candidates.length === 0) {
		return [];
	}

	const results = await Promise.all(candidates.map(async ({ worktree, baseRepository }) => {
		const [worktreeTrust, baseRepositoryTrust] = await Promise.all([
			workspaceTrustManagementService.getUriTrustInfo(worktree),
			workspaceTrustManagementService.getUriTrustInfo(baseRepository),
		]);
		return !worktreeTrust.trusted && baseRepositoryTrust.trusted ? worktree : undefined;
	}));

	const urisToTrust = results.filter((uri): uri is URI => uri !== undefined);
	if (urisToTrust.length) {
		await workspaceTrustManagementService.setUrisTrust(urisToTrust, true);
	}
	return urisToTrust;
}
