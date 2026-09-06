/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { fileURLToPath } from 'url';
import {
	DEFAULT_KIMI_INSTALL_RELATIVE,
	getDefaultKimiInstallDir,
	getRepoRoot,
	installSdkNodeModules,
	isKimiInstallCurrent,
	isKimiSdkInstalled,
	kimiSdkPackageDir,
	readKimiPin,
	writeKimiInstallStamp,
} from '../kimiInstall.ts';
import { parseCliArgs } from '../package.ts';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const INJECT_SH = path.join(REPO_ROOT, 'scripts', 'fumie-configure-agents.sh');
const AGENT_SETUP_PS1 = path.join(REPO_ROOT, 'scripts', 'fumie-configure-agents.ps1');

suite('Kimi durable SDK install paths', () => {
	test('default install dir sits in the shared agents layout, not /tmp', () => {
		const dest = getDefaultKimiInstallDir(REPO_ROOT);
		assert.strictEqual(dest, path.join(REPO_ROOT, 'build', 'agent-sdk', 'agents', 'kimi'));
		assert.strictEqual(DEFAULT_KIMI_INSTALL_RELATIVE, path.join('build', 'agent-sdk', 'agents', 'kimi'));
		assert.ok(!dest.includes(`${path.sep}tmp${path.sep}`));
		assert.strictEqual(getRepoRoot(), REPO_ROOT);
	});

	test('pin matches agents/kimi/package.json', () => {
		const pin = readKimiPin();
		assert.strictEqual(pin.name, '@moonshot-ai/kimi-code-sdk');
		assert.strictEqual(pin.version, '0.16.0');
		assert.match(pin.commit, /^[0-9a-f]{40}$/);
	});

	test('isKimiSdkInstalled requires node_modules/@moonshot-ai/kimi-code-sdk', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-install-test-'));
		try {
			assert.strictEqual(isKimiSdkInstalled(dir), false);
			fs.mkdirSync(kimiSdkPackageDir(dir), { recursive: true });
			assert.strictEqual(isKimiSdkInstalled(dir), true);
			assert.strictEqual(isKimiInstallCurrent(dir), false);
			writeKimiInstallStamp(dir);
			assert.strictEqual(isKimiInstallCurrent(dir), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('installSdkNodeModules replaces node_modules but preserves the pin descriptor', () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-install-swap-test-'));
		try {
			const staging = path.join(scratch, 'staging-node_modules');
			fs.mkdirSync(path.join(staging, 'fresh-dep'), { recursive: true });
			const installDir = path.join(scratch, 'agents', 'some-sdk');
			fs.mkdirSync(path.join(installDir, 'node_modules', 'stale-dep'), { recursive: true });
			fs.writeFileSync(path.join(installDir, 'package.json'), '{"private":true}');
			fs.writeFileSync(path.join(installDir, 'package-lock.json'), '{}');

			installSdkNodeModules(staging, installDir, false);

			assert.ok(fs.existsSync(path.join(installDir, 'package.json')), 'descriptor must survive the install');
			assert.ok(fs.existsSync(path.join(installDir, 'package-lock.json')), 'lockfile must survive the install');
			assert.ok(fs.existsSync(path.join(installDir, 'node_modules', 'fresh-dep')));
			assert.ok(!fs.existsSync(path.join(installDir, 'node_modules', 'stale-dep')), 'old node_modules must be replaced wholesale');
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('package.ts CLI accepts --install-dir and defaults target to this host', () => {
		const parsed = parseCliArgs(['--sdk=kimi', '--install-dir=build/agent-sdk/agents/kimi']);
		assert.strictEqual(parsed.sdk, 'kimi');
		assert.strictEqual(parsed.installDir, 'build/agent-sdk/agents/kimi');
		assert.strictEqual(parsed.outDir, undefined);
		assert.match(parsed.sdkTarget, /^(darwin|linux|win32)-(arm64|x64)$/);
		assert.strictEqual(parsed.force, false);
		const forced = parseCliArgs(['--sdk=kimi', '--install-dir=/tmp/nope', '--force']);
		assert.strictEqual(forced.force, true);
	});

	test('Agent setup scripts delegate SDK acquisition to the agent host manager', () => {
		const inject = fs.readFileSync(INJECT_SH, 'utf8');
		const ps1 = fs.readFileSync(AGENT_SETUP_PS1, 'utf8');
		// No per-agent SDK plumbing left in the launchers: the manager owns
		// adopt/install/report. Launchers only export the layout pointer.
		for (const script of [inject, ps1]) {
			assert.match(script, /FUMIE_AGENT_SDK_AGENTS_DIR/);
			assert.doesNotMatch(script, /\.build[\/\\]agent-sdk/);
			assert.doesNotMatch(script, /VSCODE_AGENT_HOST_[A-Z]+_SDK_ROOT=/);
			assert.doesNotMatch(script, /install-kimi-sdk/);
		}
		assert.strictEqual(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'install-kimi-sdk.sh')), false);
	});

	test('Agent launch setup never reads or exports model Provider environment', () => {
		const setupScripts = [
			fs.readFileSync(INJECT_SH, 'utf8'),
			fs.readFileSync(AGENT_SETUP_PS1, 'utf8'),
		].join('\n');
		assert.doesNotMatch(setupScripts, /ANTHROPIC_|OPENAI_|GEMINI_|DEEPSEEK_API_KEY|KIMI_MODEL_/);
	});
});
