/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Fumie: extract all nls.localize()/localize2() strings from src/vs and diff them against
 *  the bundled zh-hans language pack to produce the list of untranslated entries.
 *
 *  Usage:
 *    node scripts/fumie-l10n-extract.ts               # writes /tmp/fumie-l10n-gap.json
 *    node scripts/fumie-l10n-extract.ts --out FILE
 *---------------------------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'src');
const PACK = path.join(REPO, 'extensions/fumie-language-pack-zh-hans/translations/main.i18n.json');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : '/tmp/fumie-l10n-gap.json';

/** Statically resolve a string literal or a `+` concatenation of literals. */
function literalText(node) {
	if (ts.isStringLiteralLike(node)) {
		return node.text;
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const l = literalText(node.left);
		const r = literalText(node.right);
		return l !== undefined && r !== undefined ? l + r : undefined;
	}
	return undefined;
}

function calleeName(expr) {
	if (ts.isIdentifier(expr)) {
		return expr.text;
	}
	if (ts.isPropertyAccessExpression(expr)) {
		return expr.name.text;
	}
	return undefined;
}

/** key from arg0: 'key' | { key: 'k', comment: [...] } */
function keyInfo(node) {
	const text = literalText(node);
	if (text !== undefined) {
		return { key: text };
	}
	if (ts.isObjectLiteralExpression(node)) {
		let key, comment;
		for (const p of node.properties) {
			if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
				continue;
			}
			if (p.name.text === 'key') {
				key = literalText(p.initializer);
			} else if (p.name.text === 'comment') {
				if (ts.isArrayLiteralExpression(p.initializer)) {
					comment = p.initializer.elements.map(e => literalText(e) ?? '').join(' ');
				} else {
					comment = literalText(p.initializer);
				}
			}
		}
		return key !== undefined ? { key, comment } : undefined;
	}
	return undefined;
}

const skipped = [];
const modules = {}; // module -> { key -> { m, c? } }
let calls = 0;

function walk(dir) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		const stat = fs.statSync(full);
		if (stat.isDirectory()) {
			if (name === 'test' || name === 'fixtures' || name === 'node_modules') {
				continue;
			}
			walk(full);
		} else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('.test.')) {
			extractFile(full);
		}
	}
}

function extractFile(file) {
	const source = fs.readFileSync(file, 'utf8');
	if (!source.includes('localize')) {
		return;
	}
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, false);
	const moduleId = path.relative(SRC, file).replace(/\.ts$/, '');
	const visit = node => {
		if (ts.isCallExpression(node) && node.arguments.length >= 2) {
			const name = calleeName(node.expression);
			if (name === 'localize' || name === 'localize2') {
				calls++;
				const ki = keyInfo(node.arguments[0]);
				const message = literalText(node.arguments[1]);
				if (ki && message !== undefined) {
					const bucket = (modules[moduleId] ??= {});
					bucket[ki.key] = ki.comment ? { m: message, c: ki.comment } : { m: message };
				} else {
					skipped.push(`${moduleId} :: ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

walk(path.join(SRC, 'vs'));

const pack = JSON.parse(fs.readFileSync(PACK, 'utf8')).contents;
const gap = {};
let total = 0, covered = 0, missing = 0;
for (const [mod, entries] of Object.entries(modules)) {
	for (const [key, val] of Object.entries(entries)) {
		total++;
		if (pack[mod] && Object.prototype.hasOwnProperty.call(pack[mod], key)) {
			covered++;
		} else {
			missing++;
			(gap[mod] ??= {})[key] = val;
		}
	}
}

fs.writeFileSync(OUT, JSON.stringify(gap, null, 1));
fs.writeFileSync(OUT.replace(/\.json$/, '-all.json'), JSON.stringify(modules, null, 1));
console.log(JSON.stringify({
	files: Object.keys(modules).length,
	localizeCalls: calls,
	uniqueEntries: total,
	coveredByPack: covered,
	missing,
	unresolvable: skipped.length,
	out: OUT,
}, null, 2));
if (skipped.length) {
	console.log('unresolvable calls (first 20):');
	for (const s of skipped.slice(0, 20)) {
		console.log('  ' + s);
	}
}
