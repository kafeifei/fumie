/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fumieDebugBuildNumberPattern = /^[1-9]\d{0,18}$/;

/** Returns the user-facing label for a valid packaged Fumie Debug build number. */
export function formatFumieDebugBuildNumber(buildNumber: string | undefined): string | undefined {
	return buildNumber && fumieDebugBuildNumberPattern.test(buildNumber) ? `#${buildNumber}` : undefined;
}
