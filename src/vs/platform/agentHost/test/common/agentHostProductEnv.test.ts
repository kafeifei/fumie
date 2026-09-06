/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import product from '../../../product/common/product.js';
import { AgentHostCodexAgentBinaryPathEnvVar, AgentHostCodexAgentCodexHomeEnvVar } from '../../common/agentService.js';
import { AgentHostCodexSqliteHomeEnvVar, AgentHostCopilotHomeEnvVar, AgentHostFumieHomeEnvVar, applyAgentHostProductEnv, expandAgentHostUserPath, getAgentHostUserDataPath } from '../../common/agentHostProductEnv.js';

suite('agentHostProductEnv', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('expands a home-relative path', () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		assert.ok(home);
		assert.strictEqual(expandAgentHostUserPath('~/codex-home'), `${home}/codex-home`);
		assert.strictEqual(expandAgentHostUserPath('~'), home);
		assert.strictEqual(expandAgentHostUserPath('/abs/path'), '/abs/path');
		assert.strictEqual(expandAgentHostUserPath(undefined), undefined);
	});

	test('maps the unified legacy Codex roots from product.json', () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		const env: Record<string, string | undefined> = {};
		assert.deepStrictEqual([
			product.agentHostDefaultCodexHome,
			product.agentHostDefaultCodexSqliteHome,
		], ['~/.codex', '~/.codex']);
		applyAgentHostProductEnv(env, product);
		assert.deepStrictEqual({
			rollouts: env[AgentHostCodexAgentCodexHomeEnvVar],
			sqlite: env[AgentHostCodexSqliteHomeEnvVar],
		}, {
			rollouts: `${home}/.codex`,
			sqlite: `${home}/.codex`,
		});
	});

	test('fills Fumie home and uses it as the Agent Host data root', () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		const env: Record<string, string | undefined> = {};
		applyAgentHostProductEnv(env, { agentHostDefaultFumieHome: '~/.fumie' });
		assert.deepStrictEqual({
			home: env[AgentHostFumieHomeEnvVar],
			root: getAgentHostUserDataPath('/editor-profile', env),
			fallback: getAgentHostUserDataPath('/editor-profile', {}),
		}, {
			home: `${home}/.fumie`,
			root: `${home}/.fumie`,
			fallback: '/editor-profile',
		});
	});

	test('does not overwrite an existing sqlite home', () => {
		const env: Record<string, string | undefined> = { [AgentHostCodexSqliteHomeEnvVar]: '/custom/sqlite' };
		applyAgentHostProductEnv(env, { agentHostDefaultCodexSqliteHome: '~/.codex' });
		assert.strictEqual(env[AgentHostCodexSqliteHomeEnvVar], '/custom/sqlite');
	});

	test('fills the Copilot home from product.json but keeps an explicit one', () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		const product = { agentHostDefaultCopilotHome: '~/Library/Application Support/Fumie/copilot-home' };
		const unset: Record<string, string | undefined> = {};
		const explicit: Record<string, string | undefined> = { [AgentHostCopilotHomeEnvVar]: '/custom/copilot' };
		applyAgentHostProductEnv(unset, product);
		applyAgentHostProductEnv(explicit, product);
		assert.deepStrictEqual([unset, explicit], [
			{ [AgentHostCopilotHomeEnvVar]: `${home}/Library/Application Support/Fumie/copilot-home` },
			{ [AgentHostCopilotHomeEnvVar]: '/custom/copilot' },
		]);
	});

	test('expands inherited Codex path env vars', () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		const env: Record<string, string | undefined> = {
			[AgentHostCodexAgentCodexHomeEnvVar]: '~/Library/codex-home',
			[AgentHostCodexAgentBinaryPathEnvVar]: '~/local/bin/codex',
			[AgentHostCodexSqliteHomeEnvVar]: '~/.codex',
		};
		applyAgentHostProductEnv(env, {});
		assert.strictEqual(env[AgentHostCodexAgentCodexHomeEnvVar], `${home}/Library/codex-home`);
		assert.strictEqual(env[AgentHostCodexAgentBinaryPathEnvVar], `${home}/local/bin/codex`);
		assert.strictEqual(env[AgentHostCodexSqliteHomeEnvVar], `${home}/.codex`);
	});
});
