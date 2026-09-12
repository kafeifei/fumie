// Shared by Debug and standalone packaging. Run only against a staged app.
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const { builtinModules } = require('module');

const appResources = path.resolve(process.argv[2]);
const product = JSON.parse(fs.readFileSync(path.join(appResources, 'product.json'), 'utf8'));
if (!Array.isArray(product.sessionsAllowedAgentHostProviders) || product.sessionsAllowedAgentHostProviders.includes('copilotcli')) {
	throw new Error('Refusing to trim a product that may enable the Copilot CLI harness.');
}
const cliPackages = path.join(appResources, 'node_modules.asar.unpacked/@github');
if (fs.existsSync(cliPackages)) {
	for (const name of fs.readdirSync(cliPackages)) {
		if (name.startsWith('copilot-')) {
			fs.rmSync(path.join(cliPackages, name), { recursive: true, force: true });
			console.error(`[fumie-package] dropped ${name}`);
		}
	}
}
const extensionDir = path.join(appResources, 'extensions/copilot');
const modulesDir = path.join(extensionDir, 'node_modules');
const distDir = path.join(extensionDir, 'dist');
if (!fs.existsSync(modulesDir) || !fs.existsSync(distDir)) {
	process.exit(0);
}

const builtins = new Set(builtinModules);
const packageNameOf = specifier => {
	const segments = specifier.split('/');
	return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
};

// Fumie omits ChatSessionsContrib from the extension, alongside the Agent Host
// allowlist. The Copilot SDK can therefore be omitted from both entry paths.

// Both module systems: the bundle reaches packages only through
// `await import(...)` as well, so a require-only scan under-counts the closure.
const specifierPatterns = [
	/\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
	/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
	/\bfrom\s*["']([^"'\n]+)["']/g,
	/\bimport\s*["']([^"'\n]+)["']/g,
];
// `vscode` is supplied by the extension host, never resolved from disk.
const specifiers = new Set(['source-map-support', 'buffer-from', 'source-map', 'dotenv']);
for (const entry of fs.readdirSync(distDir, { withFileTypes: true, recursive: true })) {
	if (!entry.isFile() || !entry.name.endsWith('.js')) {
		continue;
	}
	const source = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
	for (const pattern of specifierPatterns) {
		for (const [, specifier] of source.matchAll(pattern)) {
			if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
				continue;
			}
			const name = packageNameOf(specifier);
			if (!builtins.has(name) && name !== 'vscode' && name !== '@github/copilot') {
				specifiers.add(specifier);
			}
		}
	}
}
const roots = new Set([...specifiers].map(packageNameOf));

const installedPackages = () => {
	const names = [];
	for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) {
			continue;
		}
		if (entry.name.startsWith('@')) {
			for (const scoped of fs.readdirSync(path.join(modulesDir, entry.name), { withFileTypes: true })) {
				if (scoped.isDirectory()) {
					names.push(`${entry.name}/${scoped.name}`);
				}
			}
		} else {
			names.push(entry.name);
		}
	}
	return new Set(names);
};

const installed = installedPackages();
const presentRoots = [...roots].filter(name => installed.has(name));
const presentSpecifiers = [...specifiers].filter(specifier => installed.has(packageNameOf(specifier)));

// Actually load each specifier in its own process, and load it the way the
// bundle does. `require.resolve` only proves an entry file exists:
// @azure/opentelemetry-instrumentation-azure-sdk resolves fine and then throws
// on @opentelemetry/semantic-conventions, which it never declares as a
// dependency. A separate process per specifier keeps one module's crash from
// hiding the others.
const loads = names => Object.fromEntries(names.map(name => {
	const probe = `
		import(${JSON.stringify(name)}).then(
			() => process.exit(0),
			error => process.exit(error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND' ? 1 : 0));`;
	// Anything other than a missing module means the package ran its own code,
	// which is as far as packaging can reasonably check.
	const result = cp.spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
		cwd: extensionDir,
		stdio: 'ignore',
		timeout: 30_000,
	});
	if (result.error || result.signal || ![0, 1].includes(result.status)) {
		throw new Error(`Import probe did not finish for ${name}`);
	}
	return [name, result.status === 0];
}));

const loadedBeforePruning = loads(presentSpecifiers);

// Walk package directories rather than names, and resolve each dependency the
// way Node does. A nested copy travels with its parent, but its own
// dependencies still resolve upwards to the top level: dropping
// @opentelemetry/semantic-conventions because only a nested @opentelemetry/core
// asked for it is exactly how this prune first broke the Azure instrumentation.
const resolvePackageDirectory = (fromDirectory, dependency) => {
	let current = fromDirectory;
	while (current.startsWith(extensionDir)) {
		const candidate = path.join(current, 'node_modules', dependency);
		if (fs.existsSync(path.join(candidate, 'package.json'))) {
			return candidate;
		}
		current = path.dirname(current);
	}
	return undefined;
};

const keepDirectories = new Set();
const queue = presentRoots.map(name => path.join(modulesDir, name));
while (queue.length) {
	const directory = queue.pop();
	if (keepDirectories.has(directory)) {
		continue;
	}
	keepDirectories.add(directory);
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
	} catch {
		continue;
	}
	// Peers count too: these packages reach for modules they declare only as
	// peer dependencies, or not at all.
	for (const dependency of [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]) {
		const target = resolvePackageDirectory(directory, dependency);
		if (target) {
			queue.push(target);
		}
	}
}

const keep = new Set([...installed].filter(name => name !== '@github/copilot' && keepDirectories.has(path.join(modulesDir, name))));
for (const name of installed) {
	if (!keep.has(name)) {
		fs.rmSync(path.join(modulesDir, name), { recursive: true, force: true });
	}
}
for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
	if (entry.isDirectory() && entry.name.startsWith('@') && fs.readdirSync(path.join(modulesDir, entry.name)).length === 0) {
		fs.rmdirSync(path.join(modulesDir, entry.name));
	}
}

const loadedAfterPruning = loads(presentSpecifiers);
const broken = presentSpecifiers.filter(name => loadedBeforePruning[name] && !loadedAfterPruning[name]);
if (broken.length) {
	console.error(`Pruning the Copilot extension broke these imports: ${broken.join(', ')}`);
	process.exit(1);
}

console.error(`[fumie-package] copilot node_modules: kept ${keep.size} of ${installed.size} packages (runtime roots: ${presentRoots.sort().join(', ')})`);
