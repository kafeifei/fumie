/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds one per-target tarball for one agent SDK. Callable as both a Node
 * library function (`buildOne(...)`) and a thin CLI (the bottom of this file).
 *
 * The library form is what `produce.ts` calls during the per-platform
 * "Agent SDK: build + upload" pipeline step; the CLI form is for local
 * one-off builds during development.
 *
 * Public npm SDKs use `npm ci` with `npm_config_libc/os/cpu` set to fetch the
 * foreign platform's pre-built binary package. Private source SDKs are built
 * from an exact upstream commit and frozen lockfile. The result is then
 * `tar`'d on the packaging host. Each `(sdk, target)` pair has exactly one producer
 * per pipeline run (no cross-host race), so we don't need byte-identical
 * tarballs across OSes — only across re-runs on the same host, which the
 * same npm install + same tar version produces naturally.
 *
 * SDK version pinning is described by `getAgentMeta()`: exact npm dependency
 * plus package-lock, or exact source commit plus package-manager version.
 *
 * Uses node-tar (pure JS) for tar creation rather than system tar so that
 * tarballs produced on a Windows or macOS host have the same shape as ones
 * produced on Linux — same library, same flags, same output bytes given
 * the same input tree.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { findMissingNativeOptionalDep } from '../azure-pipelines/common/checkNativeOptionalDeps.ts';
import { getAgentDir, getAgentMeta, getSdks, parseFlags, type Sdk, sha256OfFile } from './common.ts';
import { defaultHostSdkTarget, installSdkNodeModules, isKimiInstallCurrent } from './kimiInstall.ts';
import { buildKimiSourceSdk } from './kimiSource.ts';

const SCRIPT = 'package.ts';

export interface IBuildResult {
	readonly tgzPath: string;
	readonly sha256: string;
	readonly sdkVersion: string;
	readonly sizeBytes: number;
}

export interface IBuildArgs {
	readonly sdk: Sdk;
	readonly sdkTarget: string;
	/** Tarball output directory. Optional when `installDir` is set (local durable install). */
	readonly outDir?: string;
	/** Copy the built `node_modules` tree here (survives reboot; not `/tmp`). */
	readonly installDir?: string;
	/** Rebuild even if a matching Kimi pin is already installed. */
	readonly force?: boolean;
}

/**
 * Build one tarball. Acquires the SDK according to its pinned npm/source
 * metadata, normalises the resulting node_modules tree, and tars it. Returns
 * the produced `.tgz` path and its sha256.
 *
 * Determinism comes from the lockfile + node-tar's portable mode. Two
 * runs against the same lockfile on different hosts should produce the
 * same bytes — that's what the CDN's HEAD-then-fail upload depends on.
 */
export async function buildOne(args: IBuildArgs): Promise<IBuildResult> {
	if (!args.outDir && !args.installDir) {
		throw new Error(`[${SCRIPT}] Either --out or --install-dir is required`);
	}

	const meta = getAgentMeta(args.sdk);
	const { name: packageName, version: sdkVersion } = meta;
	const agentDir = getAgentDir(args.sdk);

	if (args.installDir && !args.outDir && !args.force && args.sdk === 'kimi' && isKimiInstallCurrent(args.installDir)) {
		console.log(`[${SCRIPT}] ${packageName}@${sdkVersion} already installed at ${args.installDir} (pin current; pass --force to rebuild)`);
		return { tgzPath: '', sha256: '', sdkVersion, sizeBytes: 0 };
	}

	const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-pkg-'));
	try {
		console.log(`[${SCRIPT}] Building ${packageName}@${sdkVersion} for ${args.sdkTarget} in ${stagingDir}`);

		if (meta.kind === 'source') {
			if (args.sdk !== 'kimi') {
				throw new Error(`[${SCRIPT}] Source build is not implemented for SDK '${args.sdk}'`);
			}
			buildKimiSourceSdk(stagingDir, meta);
		} else {
			// Copy the pinned package.json + package-lock.json into the scratch
			// dir. `npm ci` errors out if a node_modules is already present, so
			// the scratch dir starts clean.
			fs.copyFileSync(path.join(agentDir, 'package.json'), path.join(stagingDir, 'package.json'));
			fs.copyFileSync(path.join(agentDir, 'package-lock.json'), path.join(stagingDir, 'package-lock.json'));

			const { os: targetOs, cpu, libc } = parseTargetTriple(args.sdkTarget);
			const npmEnv: NodeJS.ProcessEnv = { npm_config_os: targetOs, npm_config_cpu: cpu };
			if (libc) {
				npmEnv.npm_config_libc = libc;
			}
			npmCi(stagingDir, npmEnv);

			const nodeModulesDir = path.join(stagingDir, 'node_modules');

			// The SDK ships its native binary in a per-platform package declared as
			// an *optional* dependency (e.g. `@openai/codex-linux-x64`). npm does not
			// fail when an optional dependency can't be installed, so a transient
			// registry hiccup can leave the base package present but the native
			// package missing — which would silently produce a binary-less tarball
			// and upload it to the (immutable, content-addressed) CDN path, failing
			// only at runtime for end users. Fail loud here instead.
			// See https://github.com/microsoft/vscode/pull/323881.
			// Claude and Codex publish their executable as a package named from the
			// SDK plus the target triple. Other public SDKs (including Pi) either
			// have no companion executable or own differently-named optional native
			// dependencies, so applying this naming check to them is a false failure.
			if (args.sdk === 'claude' || args.sdk === 'codex') {
				const missingNativeDep = findMissingNativeOptionalDep(nodeModulesDir, packageName, args.sdkTarget);
				if (missingNativeDep) {
					throw new Error(`[${SCRIPT}] npm ci left ${packageName}@${sdkVersion} without its native package '${missingNativeDep}' for target ${args.sdkTarget} — the optional dependency was silently skipped. Refusing to build a binary-less tarball; re-run to re-fetch it.`);
				}
			}

			chmodPlatformBinaries(nodeModulesDir, args.sdk);
		}

		if (args.installDir) {
			installSdkNodeModules(path.join(stagingDir, 'node_modules'), args.installDir, args.sdk === 'kimi');
			console.log(`[${SCRIPT}] Installed ${packageName}@${sdkVersion} to ${args.installDir}`);
		}

		if (!args.outDir) {
			return { tgzPath: '', sha256: '', sdkVersion, sizeBytes: 0 };
		}

		fs.mkdirSync(args.outDir, { recursive: true });
		const tgzPath = path.join(args.outDir, `${args.sdk}-${sdkVersion}-${args.sdkTarget}.tgz`);
		await buildTarball(stagingDir, tgzPath);

		const sha256 = await sha256OfFile(tgzPath);
		const sizeBytes = fs.statSync(tgzPath).size;

		console.log(`[${SCRIPT}] Wrote ${tgzPath} (${sizeBytes} bytes, sha256=${sha256})`);
		return { tgzPath, sha256, sdkVersion, sizeBytes };
	} finally {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
}

function parseTargetTriple(sdkTarget: string): { os: string; cpu: string; libc?: string } {
	// `darwin-arm64`, `linux-x64`, `linux-x64-musl`, `win32-x64`, …
	const match = /^([a-z0-9]+)-([a-z0-9]+)(?:-([a-z0-9]+))?$/.exec(sdkTarget);
	if (!match) {
		throw new Error(`[${SCRIPT}] Cannot parse target '${sdkTarget}'`);
	}
	const [, osStr, cpu, libc] = match;
	return { os: osStr, cpu, libc };
}


/**
 * Chmod the executable binaries inside a per-SDK extracted node_modules tree.
 * Layout differs per SDK; we don't pretend it's configurable:
 *   - claude: a single top-level `claude` binary per platform package
 *   - codex:  `vendor/<rust-triple>/bin/codex` under the platform package
 */
function chmodPlatformBinaries(nodeModulesDir: string, sdk: Sdk): void {
	if (sdk === 'claude') {
		const scopeDir = path.join(nodeModulesDir, '@anthropic-ai');
		if (!fs.existsSync(scopeDir)) {
			return;
		}
		for (const child of fs.readdirSync(scopeDir)) {
			if (!child.startsWith('claude-agent-sdk-')) {
				continue;
			}
			const binary = path.join(scopeDir, child, 'claude');
			if (fs.existsSync(binary)) {
				fs.chmodSync(binary, 0o755);
			}
		}
		return;
	}

	if (sdk !== 'codex') {
		return;
	}

	// codex
	const scopeDir = path.join(nodeModulesDir, '@openai');
	if (!fs.existsSync(scopeDir)) {
		return;
	}
	for (const child of fs.readdirSync(scopeDir)) {
		if (!child.startsWith('codex-')) {
			continue;
		}
		const vendorDir = path.join(scopeDir, child, 'vendor');
		if (!fs.existsSync(vendorDir)) {
			continue;
		}
		for (const triple of fs.readdirSync(vendorDir)) {
			const binDir = path.join(vendorDir, triple, 'bin');
			if (!fs.existsSync(binDir)) {
				continue;
			}
			for (const f of fs.readdirSync(binDir)) {
				fs.chmodSync(path.join(binDir, f), 0o755);
			}
		}
	}
}

function npmCi(workDir: string, env: NodeJS.ProcessEnv): void {
	// `npm ci` instead of `npm install`: installs the EXACT graph from the
	// committed package-lock.json without resolving versions, which is what
	// makes the tarball bytes reproducible across pipeline runs.
	// `--ignore-scripts` blocks any postinstall/preinstall the SDK or its
	// transitive deps might ship.
	// On Windows, npm is a `.cmd` shim. Two things matter:
	//   1. The explicit `.cmd` suffix — Node won't resolve PATHEXT.
	//   2. `shell: true` — since Node 20 (CVE-2024-27980) child_process
	//      refuses to spawn .cmd/.bat without it.
	const isWindows = process.platform === 'win32';
	const npm = isWindows ? 'npm.cmd' : 'npm';
	const result = spawnSync(npm, ['ci', '--ignore-scripts'], {
		cwd: workDir,
		env: { ...process.env, ...env },
		stdio: 'inherit',
		shell: isWindows,
	});
	if (result.error) {
		throw new Error(`[${SCRIPT}] npm ci failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`[${SCRIPT}] npm ci exited ${result.status}`);
	}
}

/**
 * Builds the gzipped tar via node-tar. Same library on every host, so the
 * output is consistent regardless of whether GNU/BSD/Windows tar is what
 * the host normally ships.
 */
async function buildTarball(stagingDir: string, outTgz: string): Promise<void> {
	await tar.c(
		{
			file: outTgz,
			cwd: stagingDir,
			gzip: { level: 9 },
			portable: true, // omit user/group names and similar host-specific metadata
			mtime: new Date(0),
		},
		['node_modules'],
	);
}

// #region CLI entry point
//
// Lets a developer run `node build/agent-sdk/package.ts --sdk=claude
// --target=darwin-arm64 --out=/tmp/out` to produce one tarball locally,
// or `--sdk=kimi --install-dir=build/agent-sdk/agents/kimi` for a durable
// source-build install (default target is this host). The gulpfile-side
// packaging uses `buildOne()` directly.

function isCliInvocation(): boolean {
	// `import.meta.filename` is already a real filesystem path; comparing
	// it directly to `process.argv[1]` works on Windows (where the
	// manual `file://${argv}` construction breaks because Node URL-encodes
	// drive letters and spaces). Pattern matches `build/npm/installStateHash.ts:143`.
	return import.meta.filename === process.argv[1];
}

export function parseCliArgs(argv = process.argv.slice(2)): IBuildArgs {
	const flags = parseFlags(argv);
	const sdk = flags.get('sdk');
	if (!sdk || !getSdks().includes(sdk)) {
		throw new Error(`--sdk must be one of ${getSdks().map(value => `'${value}'`).join(', ')}; got '${sdk}'`);
	}
	const sdkTarget = flags.get('target') ?? defaultHostSdkTarget();
	const installDir = flags.get('install-dir');
	const outDir = flags.get('out') ?? (installDir ? undefined : path.resolve(process.cwd(), 'out'));
	const force = argv.includes('--force') || flags.get('force') === '1';
	if (!outDir && !installDir) {
		throw new Error('--out=<dir> or --install-dir=<dir> is required');
	}
	return { sdk, sdkTarget, outDir, installDir, force };
}

if (isCliInvocation()) {
	buildOne(parseCliArgs()).catch(err => {
		console.error(err);
		process.exit(1);
	});
}

// #endregion
