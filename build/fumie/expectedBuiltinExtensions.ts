/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Prints the extension folder names a complete package must contain, so shell
 * packaging can validate a build without re-implementing the filters that
 * `build/lib/extensions.ts` applies.
 *
 *   node build/fumie/expectedBuiltinExtensions.ts
 *       -> JSON array of extension names
 *   node build/fumie/expectedBuiltinExtensions.ts --drop a,b --entries --format lines
 *       -> newline separated names, minus `a` and `b`, plus the `node_modules`
 *          folder that ships beside the extensions
 *
 * `--drop` fails on a name that is not in the expected set: a trimming list
 * that silently stops matching would quietly put the extension back.
 */

import { getExpectedBuiltinExtensionNames } from '../lib/extensions.ts';

const argv = process.argv.slice(2);
let drop: string[] = [];
let entries = false;
let format = 'json';

for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--drop') {
		drop = (argv[++i] ?? '').split(',').map(name => name.trim()).filter(name => name.length > 0);
	} else if (arg.startsWith('--drop=')) {
		drop = arg.slice('--drop='.length).split(',').map(name => name.trim()).filter(name => name.length > 0);
	} else if (arg === '--entries') {
		entries = true;
	} else if (arg === '--format') {
		format = argv[++i] ?? '';
	} else if (arg.startsWith('--format=')) {
		format = arg.slice('--format='.length);
	} else {
		console.error(`Unknown argument: ${arg}`);
		process.exit(2);
	}
}

if (format !== 'json' && format !== 'lines') {
	console.error(`Unknown --format: ${format}`);
	process.exit(2);
}

const expected = new Set(getExpectedBuiltinExtensionNames());

for (const name of drop) {
	if (!expected.delete(name)) {
		console.error(`Cannot drop ${name}: it is not a built-in extension of this build.`);
		process.exit(1);
	}
}

const result = [...expected];

if (entries) {
	// Shared production dependencies of the local extensions ship beside them.
	result.push('node_modules');
}

result.sort();

process.stdout.write(format === 'lines' ? result.join('\n') + '\n' : JSON.stringify(result) + '\n');
