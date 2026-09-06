/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentMeta } from './common.ts';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo-relative durable install, next to the pin descriptor so every SDK
 * lives under the one `build/agent-sdk/agents/<id>/` layout (`node_modules`
 * and the stamp are gitignored; survives reboot).
 */
export const DEFAULT_KIMI_INSTALL_RELATIVE = path.join('build', 'agent-sdk', 'agents', 'kimi');

export const KIMI_INSTALL_STAMP_NAME = '.fumie-kimi-pin.json';

export const KIMI_SDK_PACKAGE_SEGMENTS = ['node_modules', '@moonshot-ai', 'kimi-code-sdk'] as const;

export interface IKimiInstallPin {
	readonly name: string;
	readonly version: string;
	readonly commit: string;
}

export function getRepoRoot(): string {
	return path.resolve(THIS_DIR, '..', '..');
}

export function getDefaultKimiInstallDir(repoRoot = getRepoRoot()): string {
	return path.join(repoRoot, DEFAULT_KIMI_INSTALL_RELATIVE);
}

export function kimiSdkPackageDir(installDir: string): string {
	return path.join(installDir, ...KIMI_SDK_PACKAGE_SEGMENTS);
}

export function isKimiSdkInstalled(installDir: string): boolean {
	return fs.existsSync(kimiSdkPackageDir(installDir));
}

export function readKimiPin(): IKimiInstallPin {
	const meta = getAgentMeta('kimi');
	if (meta.kind !== 'source') {
		throw new Error('Kimi is expected to be a source-built SDK pin');
	}
	return { name: meta.name, version: meta.version, commit: meta.commit };
}

export function isKimiInstallCurrent(installDir: string): boolean {
	if (!isKimiSdkInstalled(installDir)) {
		return false;
	}
	const stampPath = path.join(installDir, KIMI_INSTALL_STAMP_NAME);
	if (!fs.existsSync(stampPath)) {
		return false;
	}
	const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as Partial<IKimiInstallPin>;
	const pin = readKimiPin();
	return stamp.name === pin.name && stamp.version === pin.version && stamp.commit === pin.commit;
}

export function writeKimiInstallStamp(installDir: string): void {
	fs.writeFileSync(path.join(installDir, KIMI_INSTALL_STAMP_NAME), JSON.stringify(readKimiPin(), undefined, 2) + '\n');
}

export function defaultHostSdkTarget(): string {
	const cpu = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
	if (!cpu) {
		throw new Error(`Unsupported CPU architecture '${process.arch}' for a local agent SDK install`);
	}
	switch (process.platform) {
		case 'darwin':
		case 'linux':
		case 'win32':
			return `${process.platform}-${cpu}`;
		default:
			throw new Error(`Unsupported platform '${process.platform}' for a local agent SDK install`);
	}
}

/**
 * Copy a built `node_modules` tree into `installDir` atomically (write to a
 * sibling `.installing` dir, then replace). Leaves a previous install in
 * place if the copy fails.
 */
export function installSdkNodeModules(stagingNodeModules: string, installDir: string, writeKimiStamp: boolean): void {
	if (!fs.existsSync(stagingNodeModules)) {
		throw new Error(`Refusing to install: missing ${stagingNodeModules}`);
	}
	// Replace only `node_modules` inside the install dir: the dir itself may
	// be the tracked pin descriptor (build/agent-sdk/agents/<id>/ with its
	// package.json / package-lock.json), which must survive the install.
	const targetNodeModules = path.join(installDir, 'node_modules');
	const tmpDir = `${targetNodeModules}.installing`;
	fs.rmSync(tmpDir, { recursive: true, force: true });
	try {
		fs.mkdirSync(installDir, { recursive: true });
		fs.cpSync(stagingNodeModules, tmpDir, { recursive: true });
		fs.rmSync(targetNodeModules, { recursive: true, force: true });
		fs.renameSync(tmpDir, targetNodeModules);
		if (writeKimiStamp) {
			writeKimiInstallStamp(installDir);
		}
	} catch (error) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		throw error;
	}
}
