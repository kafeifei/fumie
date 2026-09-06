/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { formatFumieDebugBuildNumber } from '../../common/fumieDebugBuildNumber.js';

suite('Fumie Debug Build Number', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats only positive decimal build numbers', () => {
		assert.strictEqual(formatFumieDebugBuildNumber('2'), '#2');
		assert.strictEqual(formatFumieDebugBuildNumber('9223372036854775807'), '#9223372036854775807');
		assert.strictEqual(formatFumieDebugBuildNumber(undefined), undefined);
		assert.strictEqual(formatFumieDebugBuildNumber(''), undefined);
		assert.strictEqual(formatFumieDebugBuildNumber('0'), undefined);
		assert.strictEqual(formatFumieDebugBuildNumber('02'), undefined);
		assert.strictEqual(formatFumieDebugBuildNumber('-1'), undefined);
		assert.strictEqual(formatFumieDebugBuildNumber('1.2'), undefined);
		assert.strictEqual(formatFumieDebugBuildNumber('92233720368547758070'), undefined);
	});
});
