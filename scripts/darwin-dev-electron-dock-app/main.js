/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fumie dock trampoline, loaded only as Electron default_app.
// code.sh runs `electron . ...`; the original default_app treats `.` as the
// app package and must keep doing that. Dock / Finder launches have no path
// and would otherwise show Electron's empty welcome — inject company
// gateway env (same helper as launch.sh) then re-exec code.sh --agents.
import * as electron from 'electron/main';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { Module } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { fileURLToPath } from 'node:url';

const { app, dialog } = electron;
const argv = process.argv.slice(1);
const option = { file: null };
for (const arg of argv) {
	if (arg === '--version' || arg === '-v' || arg === '--abi' || arg === '-a') {
		break;
	}
	if (arg.startsWith('--app=')) {
		option.file = arg.split('=')[1];
		break;
	}
	if (arg[0] === '-') {
		continue;
	}
	option.file = arg;
	break;
}

function findRepo(start) {
	let dir = start;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, 'scripts', 'code.sh'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

function showErrorMessage(message) {
	app.focus();
	dialog.showErrorBox('Error launching app', message);
	process.exit(1);
}

async function loadApplicationPackage(packagePath) {
	Object.defineProperty(process, 'defaultApp', {
		configurable: false,
		enumerable: true,
		value: true
	});
	packagePath = path.resolve(packagePath);
	const packageJsonPath = path.join(packagePath, 'package.json');
	let appPath;
	if (fs.existsSync(packageJsonPath)) {
		let packageJson;
		try {
			packageJson = (await import(url.pathToFileURL(packageJsonPath).toString(), {
				with: { type: 'json' }
			})).default;
		} catch (e) {
			showErrorMessage(`Unable to parse ${packageJsonPath}\n\n${e.message}`);
			return;
		}
		if (packageJson.version) {
			app.setVersion(packageJson.version);
		}
		if (packageJson.productName) {
			app.name = packageJson.productName;
		} else if (packageJson.name) {
			app.name = packageJson.name;
		}
		appPath = packagePath;
	}
	let filePath;
	try {
		filePath = Module._resolveFilename(packagePath, null, true);
		app.setAppPath(appPath || path.dirname(filePath));
	} catch (e) {
		showErrorMessage(`Unable to find Electron app at ${packagePath}\n\n${e.message}`);
		return;
	}
	await import(url.pathToFileURL(filePath).toString());
}

function launchAgentsFromDock() {
	if (process.env.FUMIE_DOCK_STUB_SPAWNED) {
		app.quit();
		return;
	}
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repo = findRepo(here);
	if (!repo) {
		showErrorMessage(`Could not find scripts/code.sh above ${here}`);
		return;
	}
	const inject = path.join(repo, 'scripts', 'fumie-configure-agents.sh');
	const codeSh = path.join(repo, 'scripts', 'code.sh');
	if (!fs.existsSync(inject) || !fs.existsSync(codeSh)) {
		showErrorMessage(`Missing Agent runtime setup or code.sh under ${repo}. Dock cannot launch Agents.`);
		return;
	}
	const args = ['--agents', '--disable-workspace-trust'];
	const dailyUdd = path.join(os.homedir(), 'Library', 'Application Support', 'Fumie');
	if (fs.existsSync(dailyUdd)) {
		args.push(`--user-data-dir=${dailyUdd}`);
	}
	const env = { ...process.env, FUMIE_DOCK_STUB_SPAWNED: '1', VSCODE_SKIP_PRELAUNCH: '1' };
	delete env.ELECTRON_RUN_AS_NODE;
	// Validate the source-only Agent runtime before handing off to code.sh.
	const guard = spawnSync('/bin/bash', [inject, '--check'], {
		cwd: repo,
		env,
		encoding: 'utf8',
	});
	if (guard.status !== 0) {
		showErrorMessage((guard.stderr || guard.stdout || '').trim() || 'REFUSING to launch Agents without its source runtime setup.');
		return;
	}
	const child = spawn('/bin/bash', [inject, '--exec', '--', codeSh, ...args], {
		cwd: repo,
		detached: true,
		stdio: 'ignore',
		env,
	});
	child.unref();
	app.quit();
}

if (option.file) {
	await loadApplicationPackage(option.file);
} else {
	app.whenReady().then(launchAgentsFromDock).catch((err) => {
		console.error('[fumie-dock] launch failed', err);
		app.quit();
	});
}
