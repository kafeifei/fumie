/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Fumie: validate translated batches (.build/fumie-l10n/out-*.json) and merge them into the
 *  bundled language pack's translations/main.i18n.json.
 *
 *  Usage:
 *    node scripts/fumie-l10n-merge.ts            # validate only, print report
 *    node scripts/fumie-l10n-merge.ts --write    # validate + merge valid entries into the pack
 *---------------------------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const WORK = path.join(REPO, '.build/fumie-l10n');
const PACK = path.join(REPO, 'extensions/fumie-language-pack-zh-hans/translations/main.i18n.json');
const WRITE = process.argv.includes('--write');

const placeholders = s => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
const backticks = s => (s.match(/`[^`]*`/g) ?? []).sort().join(',');

// Load source entries (id -> en)
const source = new Map();
for (const f of fs.readdirSync(WORK).filter(f => /^batch-\d+\.json$/.test(f)).sort()) {
	for (const it of JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf8'))) {
		source.set(it.i, it.en);
	}
}

// Load translations
const translated = new Map();
const outFiles = fs.readdirSync(WORK).filter(f => /^out-\d+\.json$/.test(f)).sort();
for (const f of outFiles) {
	const obj = JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf8'));
	for (const [id, zh] of Object.entries(obj)) {
		translated.set(id, zh);
	}
}

const problems = { missing: [], badPlaceholder: [], badBacktick: [], badMnemonic: [], empty: [] };
const good = new Map();
for (const [id, en] of source) {
	const zh = translated.get(id);
	if (zh === undefined) {
		problems.missing.push(id);
		continue;
	}
	if (typeof zh !== 'string' || !zh.trim()) {
		problems.empty.push(id);
		continue;
	}
	if (placeholders(en) !== placeholders(zh)) {
		problems.badPlaceholder.push(id);
		continue;
	}
	if (backticks(en) !== backticks(zh)) {
		problems.badBacktick.push(id);
		continue;
	}
	if (en.includes('&&') !== zh.includes('&&')) {
		problems.badMnemonic.push(id);
		continue;
	}
	good.set(id, zh);
}

const report = {
	outFiles: outFiles.length,
	sourceEntries: source.size,
	translatedEntries: translated.size,
	valid: good.size,
	missing: problems.missing.length,
	badPlaceholder: problems.badPlaceholder.length,
	badBacktick: problems.badBacktick.length,
	badMnemonic: problems.badMnemonic.length,
	empty: problems.empty.length,
};
console.log(JSON.stringify(report, null, 2));
for (const [kind, ids] of Object.entries(problems)) {
	for (const id of ids.slice(0, 15)) {
		console.log(`  ${kind}: ${id}`);
	}
}

// Emit a fixup batch for everything that failed
const failedIds = Object.values(problems).flat();
if (failedIds.length) {
	const fixup = failedIds.map(i => ({ i, en: source.get(i) }));
	fs.writeFileSync(path.join(WORK, 'batch-fixup.json'), JSON.stringify(fixup, null, 1));
	console.log(`wrote batch-fixup.json (${fixup.length} entries)`);
}

if (WRITE) {
	const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
	let added = 0;
	for (const [id, zh] of good) {
		const sep = id.indexOf('|');
		const mod = id.slice(0, sep);
		const key = id.slice(sep + 1);
		(pack.contents[mod] ??= {})[key] = zh;
		added++;
	}
	fs.writeFileSync(PACK, JSON.stringify(pack, null, '\t'));
	console.log(`merged ${added} entries into ${path.relative(REPO, PACK)}`);
}
