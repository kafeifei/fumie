// Stage and sign a standalone Fumie beta from a freshly built Darwin package.
// Credentials are supplied by the caller and never written into the bundle.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const { sign } = require('@electron/osx-sign');
const version = process.env.FUMIE_RELEASE_VERSION;
const identity = process.env.CODESIGN_IDENTITY;
const arch = process.arch;
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version ?? '') || !identity) {
	throw new Error('Set FUMIE_RELEASE_VERSION (x.y.z-beta.n) and CODESIGN_IDENTITY.');
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const destination = path.join(root, '.build', 'fumie-release', version);
const app = path.join(destination, 'Fumie.app');
if (fs.existsSync(app)) { throw new Error('Release staging directory already exists; use a fresh version directory.'); }
fs.mkdirSync(destination, { recursive: true });
run('ditto', ['--clone', path.resolve(root, '..', `VSCode-darwin-${arch}`, 'Fumie.app'), app]);
const resources = path.join(app, 'Contents/Resources/app');
for (const dependency of ['source-map-support', 'source-map', 'buffer-from', 'dotenv']) {
	run('ditto', ['--clone', path.join(root, 'extensions/copilot/node_modules', dependency), path.join(resources, 'extensions/copilot/node_modules', dependency)]);
}
if (!fs.existsSync(path.join(resources, 'node_modules.asar.unpacked/native-keymap/build/Release/keymapping.node'))) {
	throw new Error('Missing native-keymap binary. Run npm rebuild native-keymap before packaging.');
}
const productPath = path.join(resources, 'product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
if (product.commit !== commit) { throw new Error('Rebuild the application from the current commit before staging.'); }
product.fumieVersion = version;
// Let Codex resolve the bundled SDK instead of assuming a local CLI install.
product.agentHostDefaultCodexBinaryPath = '';
fs.writeFileSync(productPath, JSON.stringify(product, null, '\t') + '\n');
const plist = path.join(app, 'Contents/Info.plist');
run('plutil', ['-replace', 'CFBundleShortVersionString', '-string', version.split('-')[0], plist]);
run('plutil', ['-replace', 'CFBundleVersion', '-string', `${version.split('-')[0]}.${version.split('.').at(-1)}`, plist]);
run('plutil', ['-insert', 'FumieReleaseVersion', '-string', version, plist]);
run('ditto', [path.join(root, 'cli/target/release/code'), path.join(resources, 'bin', product.tunnelApplicationName)]);
const web = path.join(resources, 'web-bundle');
run('ditto', [path.join(root, 'out-fumie-web'), web]);
for (const asset of JSON.parse(fs.readFileSync(path.join(root, 'build/fumie/webBundleNodeModules.json'), 'utf8'))) {
	run('ditto', [path.join(root, 'node_modules', asset), path.join(web, 'node_modules', asset)]);
}
// Embed freshly installed, repository-pinned SDKs. The runtime already resolves
// this relative layout; no source checkout or writable signed bundle is needed.
for (const sdk of ['claude', 'codex', 'deepseek', 'kimi', 'pi']) {
	const source = path.join(root, '.build/fumie-release/sdk', sdk);
	const descriptor = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
	const names = [...Object.keys(descriptor.dependencies ?? {}), ...(descriptor.agentSdkSource ? [descriptor.agentSdkSource.name] : [])];
	if (!names.length || names.some(name => !fs.existsSync(path.join(source, 'node_modules', name)))) {
		throw new Error(`Incomplete SDK: ${sdk}`);
	}
	run('ditto', ['--clone', source, path.join(resources, 'build/agent-sdk/agents', sdk)]);
}
// Remove source maps, and reject links that escape the standalone application.
function inspect(directory) {
	for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, item.name);
		if (item.isSymbolicLink()) {
			// Some SDK tarballs declare optional CLI aliases whose targets are
			// not shipped. They are not runtime entry points; omit those aliases.
			if (!fs.existsSync(file) && path.basename(directory) === '.bin') {
				fs.unlinkSync(file);
				continue;
			}
			const target = fs.realpathSync(file);
			if (!target.startsWith(app + path.sep)) { throw new Error(`External symlink: ${path.relative(app, file)}`); }
		} else if (item.isDirectory()) { inspect(file); }
		else if (item.name.endsWith('.map')) { fs.unlinkSync(file); }
	}
}
inspect(app);
const expected = execFileSync(process.execPath, [path.join(root, 'build/fumie/expectedBuiltinExtensions.ts'), '--entries', '--format', 'lines'], { encoding: 'utf8' }).trim().split('\n').sort();
const actual = fs.readdirSync(path.join(resources, 'extensions')).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) { throw new Error('Built-in extension set mismatch'); }
await sign({
	app, identity, platform: 'darwin', type: 'distribution',
	preAutoEntitlements: false, preEmbedProvisioningProfile: false,
	ignore: file => {
		// Resources are sealed by their enclosing bundle. Sign Mach-O code
		// only, and avoid traversing framework aliases more than once.
		if (fs.realpathSync(file) !== file) { return true; }
		if (fs.statSync(file).isDirectory()) { return false; }
		const fd = fs.openSync(file, 'r');
		try {
			const magic = Buffer.alloc(4);
			fs.readSync(fd, magic, 0, 4, 0);
			return !['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex'));
		} finally { fs.closeSync(fd); }
	},
	optionsForFile: file => {
		const role = ['GPU', 'Renderer', 'Plugin'].find(role => file.includes(` Helper (${role}).app`));
		const entitlements = role ? `helper-${role.toLowerCase()}-entitlements.plist` : file.includes(' Helper.app') ? 'helper-entitlements.plist' : 'app-entitlements.plist';
		return { hardenedRuntime: true, entitlements: path.join(root, 'build/azure-pipelines/darwin', entitlements) };
	},
});
run('codesign', ['--verify', '--deep', '--strict', app]);
fs.writeFileSync(path.join(destination, 'release.json'), JSON.stringify({ version, commit, arch, codeOssVersion: product.version }, null, 2) + '\n');
console.log(app);
