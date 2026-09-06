/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isSessionsDotfileName, shouldHideSessionsDotfile, SESSIONS_FILES_SHOW_HIDDEN_SETTING } from '../../common/hiddenFiles.js';

suite('sessions hidden files', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults the show-hidden setting id', () => {
		assert.strictEqual(SESSIONS_FILES_SHOW_HIDDEN_SETTING, 'sessions.files.showHidden');
	});

	test('treats Cursor-style dotfiles as hidden', () => {
		assert.deepStrictEqual({
			git: isSessionsDotfileName('.git'),
			env: isSessionsDotfileName('.env'),
			cursor: isSessionsDotfileName('.cursor'),
			dsStore: isSessionsDotfileName('.DS_Store'),
			gitignore: isSessionsDotfileName('.gitignore'),
		}, {
			git: true,
			env: true,
			cursor: true,
			dsStore: true,
			gitignore: true,
		});
	});

	test('hides dotfiles by default even when files.exclude is empty', () => {
		assert.strictEqual(shouldHideSessionsDotfile('.env', false, false), true);
		assert.strictEqual(shouldHideSessionsDotfile('.cursor', false, false), true);
		assert.strictEqual(shouldHideSessionsDotfile('src', false, false), false);
	});

	test('shows dotfiles only when the toggle is on', () => {
		assert.strictEqual(shouldHideSessionsDotfile('.env', false, true), false);
		assert.strictEqual(shouldHideSessionsDotfile('.git', true, false), false);
	});

	test('does not hide ordinary files or . / ..', () => {
		assert.deepStrictEqual({
			src: isSessionsDotfileName('src'),
			packageJson: isSessionsDotfileName('package.json'),
			dot: isSessionsDotfileName('.'),
			dotdot: isSessionsDotfileName('..'),
			hiddenInName: isSessionsDotfileName('file.env'),
		}, {
			src: false,
			packageJson: false,
			dot: false,
			dotdot: false,
			hiddenInName: false,
		});
	});
});
