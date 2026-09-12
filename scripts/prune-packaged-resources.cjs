// Trim a staged app only. Preserve editor libraries and all Mermaid renderers.
const fs = require('node:fs');
const path = require('node:path');
const pickle = require('chromium-pickle-js');
const app = path.resolve(process.argv[2]);
if (!fs.existsSync(path.join(app, 'Contents/Resources/app/product.json'))) {
	throw new Error('Expected a staged application bundle');
}
const removed = { maps: 0, platform: 0, declarations: 0, documentation: 0 };
function directorySize(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
		const file = path.join(directory, entry.name);
		return total + (entry.isSymbolicLink() ? 0 : entry.isDirectory() ? directorySize(file) : fs.statSync(file).size);
	}, 0);
}
function rewriteAsar(file) {
	const input = fs.readFileSync(file);
	const headerSize = input.readUInt32LE(4);
	const header = JSON.parse(pickle.createFromBuffer(input.subarray(8, 8 + headerSize)).createIterator().readString());
	const chunks = []; let offset = 0; let changed = false;
	function visit(node) {
		for (const [name, entry] of Object.entries(node.files ?? {})) {
			if (entry.files) { visit(entry); continue; }
			if (name.endsWith('.map')) { removed.maps += entry.size ?? 0; delete node.files[name]; changed = true; continue; }
			if (entry.link || entry.unpacked) { continue; }
			const start = 8 + headerSize + Number(entry.offset);
			const bytes = input.subarray(start, start + entry.size);
			if (bytes.length !== entry.size) { throw new Error('Invalid ASAR entry bounds'); }
			entry.offset = String(offset); offset += bytes.length; chunks.push(bytes);
		}
	}
	visit(header);
	if (!changed) { return; }
	const hp = pickle.createEmpty(); hp.writeString(JSON.stringify(header));
	const hb = hp.toBuffer(); const sp = pickle.createEmpty(); sp.writeUInt32(hb.length);
	const temporary = file + '.trim-tmp';
	fs.writeFileSync(temporary, Buffer.concat([sp.toBuffer(), hb, ...chunks]), { mode: fs.statSync(file).mode });
	fs.renameSync(temporary, file);
}
function visit(dir, sdk = false) {
	for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, item.name);
		if (item.isSymbolicLink()) { continue; }
		if (item.isDirectory()) {
			// Restrict pruning to SDK dependencies, never editor or Mermaid assets.
			const sdkChild = sdk || file === path.join(app, 'Contents/Resources/app/build/agent-sdk/agents');
			if (sdk && /^(win32|linux|darwin)-(arm64|x64|ia32|arm)$/.test(item.name) && item.name !== `${process.platform}-${process.arch}`) {
				removed.platform += directorySize(file); fs.rmSync(file, { recursive: true }); continue;
			}
			if (sdk && file.includes('/node_modules/') && ['test', 'tests', '__tests__', 'docs', 'examples'].includes(item.name) && !file.includes('/@earendil-works/pi-coding-agent/docs') && !file.includes('/@earendil-works/pi-coding-agent/examples')) {
				removed.documentation += directorySize(file); fs.rmSync(file, { recursive: true }); continue;
			}
			visit(file, sdkChild);
		} else if (item.isFile()) {
			if (item.name.endsWith('.asar')) { rewriteAsar(file); }
			else if (item.name.endsWith('.map')) { removed.maps += fs.statSync(file).size; fs.unlinkSync(file); }
			else if (sdk && /\.d\.(ts|mts|cts)$/.test(item.name) && !file.includes('/node_modules/typescript/')) { removed.declarations += fs.statSync(file).size; fs.unlinkSync(file); }
		}
	}
}
visit(app);
console.log(JSON.stringify(removed));
