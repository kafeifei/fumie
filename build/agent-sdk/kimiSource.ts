/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { ISourceAgentMeta } from './common.ts';

const SCRIPT = 'kimiSource.ts';

/**
 * Builds Kimi's private Node SDK from an exact upstream commit into the
 * staging `node_modules` tree used by the common agent SDK packager.
 */
export function buildKimiSourceSdk(stagingDir: string, meta: ISourceAgentMeta): void {
	const sourceDir = path.join(stagingDir, 'source');
	clonePinnedSource(sourceDir, meta);
	validateUpstreamPins(sourceDir, meta);
	installPinnedDependencies(sourceDir);

	const outputDir = path.join(sourceDir, 'fumie-sdk-dist');
	const configPath = path.join(sourceDir, 'fumie-sdk.config.mjs');
	fs.writeFileSync(configPath, createBuildConfig(meta.target));
	run('corepack', ['pnpm', '--config.engine-strict=false', 'exec', 'tsdown', '--config', configPath], sourceDir);

	const entrypoint = path.join(outputDir, 'index.mjs');
	if (!fs.existsSync(entrypoint)) {
		throw new Error(`[${SCRIPT}] Kimi SDK build did not produce ${entrypoint}`);
	}
	normalizeEmbeddedSourcePaths(outputDir, sourceDir);
	assertSelfContainedEsm(outputDir);

	const packageDir = path.join(stagingDir, 'node_modules', '@moonshot-ai', 'kimi-code-sdk');
	fs.mkdirSync(packageDir, { recursive: true });
	fs.cpSync(outputDir, path.join(packageDir, 'dist'), { recursive: true });
	fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
		name: meta.name,
		version: meta.version,
		private: true,
		type: 'module',
		license: 'MIT',
		exports: {
			'.': './dist/index.mjs',
		},
	}, undefined, 2) + '\n');
	copyIfPresent(path.join(sourceDir, 'LICENSE'), path.join(packageDir, 'LICENSE'));
	copyIfPresent(path.join(sourceDir, 'packages', 'node-sdk', 'README.md'), path.join(packageDir, 'README.md'));
}

function clonePinnedSource(sourceDir: string, meta: ISourceAgentMeta): void {
	fs.mkdirSync(sourceDir, { recursive: true });
	run('git', ['init', '--quiet'], sourceDir);
	run('git', ['remote', 'add', 'origin', meta.repository], sourceDir);
	run('git', ['fetch', '--quiet', '--depth=1', 'origin', meta.commit], sourceDir);
	run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], sourceDir);
	const actualCommit = runAndCapture('git', ['rev-parse', 'HEAD'], sourceDir);
	if (actualCommit !== meta.commit) {
		throw new Error(`[${SCRIPT}] Expected Kimi source commit ${meta.commit}, got ${actualCommit}`);
	}
}

function validateUpstreamPins(sourceDir: string, meta: ISourceAgentMeta): void {
	const rootPackage = readJson(path.join(sourceDir, 'package.json'));
	if (rootPackage.packageManager !== meta.packageManager) {
		throw new Error(`[${SCRIPT}] Kimi package manager changed at ${meta.commit}: expected ${meta.packageManager}, got ${String(rootPackage.packageManager)}`);
	}
	const sdkPackage = readJson(path.join(sourceDir, 'packages', 'node-sdk', 'package.json'));
	if (sdkPackage.name !== meta.name || sdkPackage.version !== meta.version) {
		throw new Error(`[${SCRIPT}] Kimi SDK identity changed at ${meta.commit}: expected ${meta.name}@${meta.version}, got ${String(sdkPackage.name)}@${String(sdkPackage.version)}`);
	}
	if (!fs.existsSync(path.join(sourceDir, 'pnpm-lock.yaml'))) {
		throw new Error(`[${SCRIPT}] Kimi source at ${meta.commit} has no pnpm-lock.yaml`);
	}
}

function installPinnedDependencies(sourceDir: string): void {
	run('corepack', [
		'pnpm',
		'--config.engine-strict=false',
		'install',
		'--frozen-lockfile',
		'--ignore-scripts',
	], sourceDir);
}

function createBuildConfig(target: string): string {
	return `import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from './build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./packages/node-sdk/src/index.ts'],
  format: ['esm'],
  target: ${JSON.stringify(target)},
  codeSplitting: false,
  outDir: 'fumie-sdk-dist',
  clean: true,
  dts: false,
  plugins: [rawTextPlugin()],
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\\n'),
  },
  alias: {
    '@moonshot-ai/agent-core': fileURLToPath(new URL('./packages/agent-core/src/index.ts', import.meta.url)),
    '@moonshot-ai/kaos': fileURLToPath(new URL('./packages/kaos/src/index.ts', import.meta.url)),
    '@moonshot-ai/kimi-code-oauth': fileURLToPath(new URL('./packages/oauth/src/index.ts', import.meta.url)),
    '@moonshot-ai/kosong': fileURLToPath(new URL('./packages/kosong/src/index.ts', import.meta.url)),
  },
  deps: {
    onlyBundle: false,
    alwaysBundle: [/^@moonshot-ai\\//, 'zod'],
    neverBundle: [],
  },
  outputOptions: {
    entryFileNames: 'index.mjs',
    // tsdown 0.22 still requires Rolldown's legacy spelling to inline
    // dynamic imports; codeSplitting=false alone leaves hashed chunks.
    inlineDynamicImports: true,
  },
});
`;
}

function assertSelfContainedEsm(outputDir: string): void {
	const builtins = new Set(builtinModules.flatMap(module => [module, `node:${module}`]));
	// Rolldown preserves dependency documentation comments, including example
	// imports. Anchor at the beginning of a generated statement so those
	// examples are not mistaken for live runtime dependencies.
	const importPattern = /^\s*(?:import\s+(?:[^'"\n;]*?\s+from\s+)?|export\s+[^'"\n;]*?\s+from\s+)['"]([^'"]+)['"]/gm;
	for (const file of fs.readdirSync(outputDir)) {
		if (!file.endsWith('.mjs')) {
			continue;
		}
		const source = fs.readFileSync(path.join(outputDir, file), 'utf8');
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1];
			if (!specifier.startsWith('.') && !builtins.has(specifier)) {
				throw new Error(`[${SCRIPT}] Kimi SDK output ${file} retains non-builtin import '${specifier}'`);
			}
		}
	}
}

/**
 * Rolldown preserves each input module's `import.meta.url` as an absolute
 * source-checkout URL. The checkout lives in a random scratch directory, so
 * those otherwise-dead strings make identical builds hash differently. The
 * source tree is deleted before the tarball is returned, so no shipped code
 * may rely on it; normalize every spelling to a stable diagnostic-only root.
 */
function normalizeEmbeddedSourcePaths(outputDir: string, sourceDir: string): void {
	const sourceUrl = pathToFileURL(sourceDir).href;
	const portableSourceDir = sourceDir.replaceAll('\\', '/');
	const escapedWindowsSourceDir = sourceDir.replaceAll('\\', '\\\\');
	for (const file of fs.readdirSync(outputDir)) {
		if (!file.endsWith('.mjs')) {
			continue;
		}
		const filePath = path.join(outputDir, file);
		let source = fs.readFileSync(filePath, 'utf8');
		source = source
			.replaceAll(sourceUrl, 'file:///__vscode_kimi_source__')
			.replaceAll(escapedWindowsSourceDir, '/__vscode_kimi_source__')
			.replaceAll(portableSourceDir, '/__vscode_kimi_source__')
			.replaceAll(sourceDir, '/__vscode_kimi_source__');
		if (source.includes(path.basename(path.dirname(sourceDir)))) {
			throw new Error(`[${SCRIPT}] Kimi SDK output ${file} still contains its random staging directory`);
		}
		fs.writeFileSync(filePath, source);
	}
}

function readJson(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function copyIfPresent(source: string, target: string): void {
	if (fs.existsSync(source)) {
		fs.copyFileSync(source, target);
	}
}

function run(command: string, args: readonly string[], cwd: string): void {
	const isWindowsCommand = process.platform === 'win32' && command === 'corepack';
	const executable = isWindowsCommand ? `${command}.cmd` : command;
	const result = spawnSync(executable, args, {
		cwd,
		env: { ...process.env, CI: 'true' },
		stdio: 'inherit',
		shell: isWindowsCommand,
	});
	if (result.error) {
		throw new Error(`[${SCRIPT}] ${command} failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`[${SCRIPT}] ${command} ${args.join(' ')} exited ${result.status}`);
	}
}

function runAndCapture(command: string, args: readonly string[], cwd: string): string {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) {
		throw new Error(`[${SCRIPT}] ${command} failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`[${SCRIPT}] ${command} ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
	}
	return result.stdout.trim();
}
