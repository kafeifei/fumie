const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const asar = require('asar');
const { test } = require('node:test');

test('pruning preserves archive contents, links, native metadata and runtime resources', async () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-prune-'));
	try {
		const app = path.join(temp, 'Fumie.app');
		const resources = path.join(app, 'Contents/Resources/app');
		const source = path.join(temp, 'archive-source');
		const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
		write(path.join(resources, 'product.json'), '{}');
		write(path.join(source, 'main.js'), 'module.exports = 42;');
		write(path.join(source, 'main.js.map'), 'discard');
		write(path.join(source, 'nested/keep.json'), '{"answer":42}');
		write(path.join(source, 'native.node'), 'native-placeholder');
		fs.symlinkSync('main.js', path.join(source, 'alias.js'));
		const archive = path.join(resources, 'node_modules.asar');
		await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
		const sdk = path.join(resources, 'build/agent-sdk/agents/test/node_modules/package');
		const foreign = process.platform === 'win32' ? 'linux-x64' : 'win32-x64';
		write(path.join(sdk, 'prebuilds', foreign, 'binding.node'), 'discard');
		write(path.join(sdk, 'prebuilds', `${process.platform}-${process.arch}`, 'binding.node'), 'keep');
		write(path.join(sdk, 'index.d.ts'), 'discard');
		write(path.join(sdk, 'index.js'), 'keep');
		write(path.join(sdk, 'test/fixture.txt'), 'discard');
		write(path.join(sdk, 'LICENSE'), 'keep');
		const piDocs = path.join(resources, 'build/agent-sdk/agents/pi/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md');
		const mermaid = path.join(resources, 'extensions/mermaid-markdown-features/index.js');
		const editorTypes = path.join(resources, 'extensions/node_modules/typescript/lib/lib.d.ts');
		write(piDocs, 'runtime documentation'); write(mermaid, 'mermaid'); write(editorTypes, 'editor declarations');
		const run = () => execFileSync(process.execPath, [path.resolve(__dirname, '../prune-packaged-resources.cjs'), app]);
		run(); asar.uncache(archive);
		assert.equal(asar.extractFile(archive, 'main.js').toString(), 'module.exports = 42;');
		assert.equal(asar.extractFile(archive, 'alias.js').toString(), 'module.exports = 42;');
		assert.equal(asar.extractFile(archive, 'nested/keep.json').toString(), '{"answer":42}');
		assert.equal(asar.extractFile(archive, 'native.node').toString(), 'native-placeholder');
		assert.equal(asar.statFile(archive, 'native.node').unpacked, true);
		assert(!asar.listPackage(archive).some(name => name.endsWith('.map')));
		for (const name of ['index.d.ts', 'test', `prebuilds/${foreign}`]) { assert(!fs.existsSync(path.join(sdk, name))); }
		for (const file of [piDocs, mermaid, editorTypes, path.join(sdk, 'LICENSE'), path.join(sdk, 'prebuilds', `${process.platform}-${process.arch}`, 'binding.node')]) { assert(fs.existsSync(file)); }
		const first = fs.readFileSync(archive); run(); assert.deepEqual(fs.readFileSync(archive), first);
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
