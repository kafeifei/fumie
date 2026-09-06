/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { SpawnOptions } from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeOfficialLoginExecutable, createClaudeOfficialLoginEnvironment, resolveClaudeDevSdkRoot, runClaudeOfficialLogin, runClaudeOfficialLogout, type IClaudeOfficialLoginProcess } from '../../node/claude/claudeOfficialLogin.js';

suite('Claude official login', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the executable from the SDK platform package', () => {
		assert.strictEqual(
			claudeOfficialLoginExecutable('/sdk', 'darwin-arm64', 'darwin'),
			'/sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
		);
		assert.strictEqual(
			claudeOfficialLoginExecutable('/sdk', 'win32-x64', 'win32'),
			'/sdk/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
		);
	});

	test('resolves a source checkout root from the public package', async () => {
		assert.strictEqual(
			await resolveClaudeDevSdkRoot(() => '/repo/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
			'/repo',
		);
		assert.strictEqual(await resolveClaudeDevSdkRoot(() => { throw new Error('missing'); }), undefined);
	});

	test('keeps the normal Claude config while removing provider and host-owned auth inputs', () => {
		assert.deepStrictEqual(createClaudeOfficialLoginEnvironment({
			HOME: '/home/person',
			CLAUDE_CONFIG_DIR: '/home/person/.claude-alt',
			BROWSER: '/usr/bin/open',
			ANTHROPIC_API_KEY: 'secret',
			CLAUDE_CODE_OAUTH_TOKEN: 'secret',
			CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'secret',
			CLAUDE_CODE_OAUTH_SCOPES: 'scope',
			CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
			CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '9',
			CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
			CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
			ELECTRON_RUN_AS_NODE: '1',
			NODE_OPTIONS: '--inspect',
		}), {
			HOME: '/home/person',
			CLAUDE_CONFIG_DIR: '/home/person/.claude-alt',
			BROWSER: '/usr/bin/open',
		});
	});

	test('spawns only `auth login` without a shell and waits for exit', async () => {
		const child = new EventEmitter();
		let call: { file: string; args: readonly string[]; options: SpawnOptions } | undefined;
		const completion = runClaudeOfficialLogin('/sdk/claude', { HOME: '/home/person', ANTHROPIC_API_KEY: 'secret' }, (file, args, options) => {
			call = { file, args, options };
			return child as unknown as IClaudeOfficialLoginProcess;
		});
		child.emit('exit', 0, null);
		await completion;

		assert.deepStrictEqual({
			file: call?.file,
			args: call?.args,
			shell: call?.options.shell,
			stdio: call?.options.stdio,
			home: call?.options.env?.HOME,
			apiKey: call?.options.env?.ANTHROPIC_API_KEY,
		}, {
			file: '/sdk/claude',
			args: ['auth', 'login'],
			shell: false,
			stdio: 'ignore',
			home: '/home/person',
			apiKey: undefined,
		});
	});

	test('spawns `auth logout`, the CLI\'s own sign-out, under the same environment', async () => {
		const child = new EventEmitter();
		let call: { file: string; args: readonly string[]; options: SpawnOptions } | undefined;
		const completion = runClaudeOfficialLogout('/sdk/claude', { HOME: '/home/person', ANTHROPIC_API_KEY: 'secret' }, (file, args, options) => {
			call = { file, args, options };
			return child as unknown as IClaudeOfficialLoginProcess;
		});
		child.emit('exit', 0, null);
		await completion;

		assert.deepStrictEqual({
			args: call?.args,
			shell: call?.options.shell,
			home: call?.options.env?.HOME,
			apiKey: call?.options.env?.ANTHROPIC_API_KEY,
		}, {
			args: ['auth', 'logout'],
			shell: false,
			home: '/home/person',
			apiKey: undefined,
		});
	});

	test('abandoning the attempt kills the waiting login and settles without an error', async () => {
		// `claude auth login` waits on a browser round-trip that never arrives when
		// the user cancels out there, so abandoning it has to terminate the process
		// rather than wait — and the kill is not a failure worth reporting.
		const child = new EventEmitter() as EventEmitter & { kill(): boolean };
		const signals: string[] = [];
		child.kill = () => { signals.push('kill'); child.emit('exit', null, 'SIGTERM'); return true; };
		const cts = new CancellationTokenSource();
		const completion = runClaudeOfficialLogin('/sdk/claude', {}, () => child as unknown as IClaudeOfficialLoginProcess, cts.token);

		cts.cancel();
		await completion;

		assert.deepStrictEqual(signals, ['kill']);
		cts.dispose();
	});

	test('rejects non-zero exit and spawn failure without reading process output', async () => {
		const exited = new EventEmitter();
		const nonZero = runClaudeOfficialLogin('/sdk/claude', {}, () => exited as unknown as IClaudeOfficialLoginProcess);
		exited.emit('exit', 1, null);
		await assert.rejects(nonZero, /status 1/);

		const failed = new EventEmitter();
		const spawnFailure = runClaudeOfficialLogin('/sdk/claude', {}, () => failed as unknown as IClaudeOfficialLoginProcess);
		failed.emit('error', new Error('spawn failed'));
		await assert.rejects(spawnFailure, /spawn failed/);
	});
});
