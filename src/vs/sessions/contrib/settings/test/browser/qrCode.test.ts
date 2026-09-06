/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { encodeQrCode, renderQrCode, selectVersion, type IQrCode } from '../../browser/qrCode.js';

/**
 * The pairing code on the Remote Connections page.
 *
 * A QR code is either read by a phone or it is nothing, and no one can tell
 * which by eye — so every assertion below is one a reader makes: where the
 * finders, separators, timing and alignment patterns are, what the format bits
 * say, and whether the modules, unmasked and read in the spec's order, give
 * back the address they were built from.
 *
 * The layout the tests need is derived here from the spec rather than imported
 * from the encoder, so a matrix built the wrong way round cannot agree with the
 * test that reads it.
 */
suite('Sessions - Agent Settings QR code', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A tunnel address of the length this card actually has to carry. */
	const url = `https://abcdefgh-9999.usw2.devtunnels.ms/?pairing=${'a'.repeat(70)}`;

	/**
	 * The level-M block layout of the versions exercised below, transcribed
	 * from the spec's tables. Every one of these splits its data into blocks of
	 * equal length, which is what lets the reader below de-interleave without
	 * repeating the encoder's arithmetic.
	 */
	const BLOCKS_AT_LEVEL_M = new Map<number, { readonly blocks: number; readonly dataCodewords: number }>([
		[1, { blocks: 1, dataCodewords: 16 }],
		[2, { blocks: 1, dataCodewords: 28 }],
		[3, { blocks: 1, dataCodewords: 44 }],
		[7, { blocks: 4, dataCodewords: 124 }],
	]);

	function encode(text: string): IQrCode {
		const code = encodeQrCode(text);
		assert.ok(code, `expected '${text.slice(0, 32)}…' to encode`);
		return code;
	}

	function alignmentCenters(version: number): number[] {
		if (version === 1) {
			return [];
		}
		const count = Math.floor(version / 7) + 2;
		const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
		const centers = [6];
		for (let pos = version * 4 + 10; centers.length < count; pos -= step) {
			centers.splice(1, 0, pos);
		}
		return centers;
	}

	/** Everything a reader treats as structure, and so never reads as data. */
	function functionModules(version: number): boolean[][] {
		const size = version * 4 + 17;
		const map: boolean[][] = [];
		for (let y = 0; y < size; y++) {
			map.push(new Array<boolean>(size).fill(false));
		}
		const reserve = (x0: number, x1: number, y0: number, y1: number) => {
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					map[y][x] = true;
				}
			}
		};
		// Each finder, its separator, and the format bits beside it.
		reserve(0, 8, 0, 8);
		reserve(size - 8, size - 1, 0, 8);
		reserve(0, 8, size - 8, size - 1);
		for (let i = 0; i < size; i++) {
			map[6][i] = true;
			map[i][6] = true;
		}
		for (const [x, y] of alignmentPatterns(version)) {
			reserve(x - 2, x + 2, y - 2, y + 2);
		}
		if (version >= 7) {
			for (let i = 0; i < 18; i++) {
				const far = size - 11 + i % 3;
				const near = Math.floor(i / 3);
				map[near][far] = true;
				map[far][near] = true;
			}
		}
		return map;
	}

	/** Alignment pattern centres, minus the three the finders already occupy. */
	function alignmentPatterns(version: number): [number, number][] {
		const centers = alignmentCenters(version);
		const result: [number, number][] = [];
		for (let i = 0; i < centers.length; i++) {
			for (let j = 0; j < centers.length; j++) {
				const corner = (i === 0 && j === 0)
					|| (i === 0 && j === centers.length - 1)
					|| (i === centers.length - 1 && j === 0);
				if (!corner) {
					result.push([centers[i], centers[j]]);
				}
			}
		}
		return result;
	}

	function maskAt(mask: number, x: number, y: number): boolean {
		switch (mask) {
			case 0: return (x + y) % 2 === 0;
			case 1: return y % 2 === 0;
			case 2: return x % 3 === 0;
			case 3: return (x + y) % 3 === 0;
			case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
			case 5: return x * y % 2 + x * y % 3 === 0;
			case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
			default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
		}
	}

	/** Unmask, then read `count` codewords in the spec's zigzag order. */
	function readCodewords(code: IQrCode, count: number): number[] {
		const map = functionModules(code.version);
		const size = code.size;
		const codewords: number[] = [];
		let current = 0;
		let bits = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			// Column 6 is the vertical timing pattern; the pairs step over it.
			if (right === 6) {
				right = 5;
			}
			for (let vertical = 0; vertical < size; vertical++) {
				for (let column = 0; column < 2; column++) {
					const x = right - column;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? size - 1 - vertical : vertical;
					if (map[y][x] || codewords.length >= count) {
						continue;
					}
					const dark = code.modules[y][x] !== maskAt(code.mask, x, y);
					current = (current << 1) | (dark ? 1 : 0);
					if (++bits === 8) {
						codewords.push(current);
						current = 0;
						bits = 0;
					}
				}
			}
		}
		assert.strictEqual(codewords.length, count, 'expected enough data modules to read');
		return codewords;
	}

	/** The data codewords, de-interleaved back into the order they were written. */
	function readDataCodewords(code: IQrCode): number[] {
		const layout = BLOCKS_AT_LEVEL_M.get(code.version);
		assert.ok(layout, `this test only reads versions ${[...BLOCKS_AT_LEVEL_M.keys()].join(', ')}`);
		const stream = readCodewords(code, layout.dataCodewords);
		const perBlock = layout.dataCodewords / layout.blocks;
		assert.strictEqual(perBlock % 1, 0, 'these versions split into equal blocks');

		const result: number[] = [];
		for (let block = 0; block < layout.blocks; block++) {
			for (let i = 0; i < perBlock; i++) {
				result.push(stream[i * layout.blocks + block]);
			}
		}
		return result;
	}

	/** What a reader hands back: the byte-mode payload, as text. */
	function readPayload(code: IQrCode): string {
		const bits: number[] = [];
		for (const codeword of readDataCodewords(code)) {
			for (let i = 7; i >= 0; i--) {
				bits.push((codeword >>> i) & 1);
			}
		}
		let at = 0;
		const take = (count: number) => {
			let value = 0;
			for (let i = 0; i < count; i++) {
				value = (value << 1) | bits[at++];
			}
			return value;
		};
		assert.strictEqual(take(4), 0b0100, 'byte mode indicator');
		const length = take(code.version <= 9 ? 8 : 16);
		const bytes: number[] = [];
		for (let i = 0; i < length; i++) {
			bytes.push(take(8));
		}
		return new TextDecoder().decode(Uint8Array.from(bytes));
	}

	/** The 15 format bits, as the two copies a reader can choose between. */
	function readFormatBits(code: IQrCode, copy: 0 | 1): number {
		const size = code.size;
		const modules = code.modules;
		const bits: boolean[] = [];
		if (copy === 0) {
			for (let i = 0; i <= 5; i++) {
				bits[i] = modules[i][8];
			}
			bits[6] = modules[7][8];
			bits[7] = modules[8][8];
			bits[8] = modules[8][7];
			for (let i = 9; i < 15; i++) {
				bits[i] = modules[8][14 - i];
			}
		} else {
			for (let i = 0; i < 8; i++) {
				bits[i] = modules[8][size - 1 - i];
			}
			for (let i = 8; i < 15; i++) {
				bits[i] = modules[size - 15 + i][8];
			}
		}
		let value = 0;
		for (let i = 0; i < 15; i++) {
			if (bits[i]) {
				value |= 1 << i;
			}
		}
		return value;
	}

	test('the version is the smallest that holds the address, and fixes the size', () => {
		assert.strictEqual(encode('hello').version, 1);
		assert.strictEqual(encode('hello').size, 21);

		assert.strictEqual(url.length, 120, 'the fixture is the length this card has to carry');
		assert.strictEqual(encode(url).version, 7);
		assert.strictEqual(encode(url).size, 45);
	});

	test('version selection lands exactly on the published level-M byte capacities', () => {
		// One byte past a version's capacity has to move up a version; the
		// alternative is a code that silently drops the end of the address.
		for (const [version, capacity] of [[1, 14], [2, 26], [3, 42], [6, 106], [7, 122], [9, 180], [10, 213]]) {
			assert.strictEqual(selectVersion(capacity), version, `${capacity} bytes fills version ${version}`);
			assert.ok(selectVersion(capacity + 1)! > version, `${capacity + 1} bytes must not fit version ${version}`);
		}
		assert.strictEqual(selectVersion(2331), 40, 'the level-M ceiling');
		assert.strictEqual(selectVersion(2332), undefined);
		assert.strictEqual(encodeQrCode('x'.repeat(2332)), undefined, 'too long is undefined, never a truncated code');
	});

	test('the three finder patterns are drawn, each with its separator', () => {
		const code = encode(url);
		const modules = code.modules;
		const size = code.size;

		for (const [originX, originY] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
			for (let dy = 0; dy < 7; dy++) {
				for (let dx = 0; dx < 7; dx++) {
					// Dark everywhere but the one-module ring at Chebyshev distance 2.
					const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
					assert.strictEqual(
						modules[originY + dy][originX + dx],
						ring !== 2,
						`finder at ${originX},${originY}, module ${dx},${dy}`);
				}
			}
		}

		for (let i = 0; i < 8; i++) {
			assert.strictEqual(modules[7][i], false, 'top-left separator, below');
			assert.strictEqual(modules[i][7], false, 'top-left separator, right');
			assert.strictEqual(modules[7][size - 1 - i], false, 'top-right separator, below');
			assert.strictEqual(modules[size - 1 - i][7], false, 'bottom-left separator, right');
		}
	});

	test('the timing patterns alternate all the way between the finders', () => {
		const code = encode(url);
		for (let i = 8; i < code.size - 8; i++) {
			assert.strictEqual(code.modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
			assert.strictEqual(code.modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
		}
	});

	test('every alignment pattern the version calls for is drawn, and none in a finder corner', () => {
		const code = encode(url);
		const centres = alignmentPatterns(code.version);
		assert.deepStrictEqual(
			centres,
			[[6, 22], [22, 6], [22, 22], [22, 38], [38, 22], [38, 38]],
			'version 7 places six alignment patterns');

		for (const [centreX, centreY] of centres) {
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					assert.strictEqual(
						code.modules[centreY + dy][centreX + dx],
						Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
						`alignment at ${centreX},${centreY}, module ${dx},${dy}`);
				}
			}
		}
	});

	test('the dark module is set, at every version', () => {
		for (const text of ['hello', 'https://fumie.example/pair?k=abc', url]) {
			const code = encode(text);
			assert.strictEqual(code.modules[code.size - 8][8], true, `dark module at version ${code.version}`);
		}
	});

	test('both copies of the format bits name level M and the mask that was applied', () => {
		for (const text of ['hello', 'https://fumie.example/pair?k=abc', url]) {
			const code = encode(text);
			const first = readFormatBits(code, 0);
			assert.strictEqual(readFormatBits(code, 1), first, 'the two copies must agree');

			// A valid BCH(15,5) word: with the spec's 0x5412 mask taken off, the
			// remainder against generator 0x537 is zero.
			let remainder = first ^ 0x5412;
			for (let bit = 14; bit >= 10; bit--) {
				if (remainder & (1 << bit)) {
					remainder ^= 0x537 << (bit - 10);
				}
			}
			assert.strictEqual(remainder & 0x3FF, 0, 'format bits must survive their own error correction');

			const data = (first ^ 0x5412) >>> 10;
			assert.strictEqual(data >> 3, 0b00, 'error correction level M');
			assert.strictEqual(data & 7, code.mask, 'the mask the format bits promise is the one applied');
		}
	});

	test('the same address always draws the same code', () => {
		const first = encode(url);
		const second = encode(url);
		assert.strictEqual(first.version, second.version);
		assert.strictEqual(first.mask, second.mask);
		assert.deepStrictEqual(first.modules, second.modules);
	});

	test(`'HELLO' encodes to the codewords the spec spells out`, () => {
		// Byte mode 0100, length 5, the five bytes, a 0000 terminator, then the
		// spec's alternating pad — worked out by hand, so a rewrite of the bit
		// packing cannot quietly redefine what "correct" means here.
		const code = encode('HELLO');
		assert.strictEqual(code.version, 1);
		assert.deepStrictEqual(readDataCodewords(code), [
			0x40, 0x54, 0x84, 0x54, 0xC4, 0xC4, 0xF0,
			0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC,
		]);
	});

	test('the modules, unmasked and read in order, give back the address', () => {
		// The last one is the case this card is for: an address too long for a
		// single block, so it has to survive being split and interleaved too.
		for (const text of ['hello', 'https://fumie.example/pair?k=abc', 'naïve café ☕', url]) {
			assert.strictEqual(readPayload(encode(text)), text);
		}
	});

	test('the rendered code keeps the quiet zone a reader needs to find it', () => {
		const code = encode(url);
		const container = document.createElement('div');
		const svg = renderQrCode(container, code, { ariaLabel: 'Pairing code', title: url });

		assert.strictEqual(svg.parentElement, container);
		assert.strictEqual(svg.getAttribute('role'), 'img');
		assert.strictEqual(svg.getAttribute('aria-label'), 'Pairing code');
		assert.strictEqual(svg.querySelector('title')?.textContent, url, 'the address stays one hover away');

		const extent = code.size + 8;
		assert.strictEqual(svg.getAttribute('viewBox'), `0 0 ${extent} ${extent}`);
		const plate = svg.querySelector('.agent-settings-qr-plate');
		assert.ok(plate, 'expected a plate behind the modules');
		assert.strictEqual(plate.getAttribute('width'), `${extent}`);
		assert.strictEqual(plate.getAttribute('height'), `${extent}`);

		// Neither colour is written from script: the theme owns the contrast.
		assert.strictEqual(svg.getAttribute('fill'), null);
		assert.strictEqual(plate.getAttribute('fill'), null);
	});

	test('the drawn path is exactly the dark modules, offset by the quiet zone', () => {
		const code = encode('https://fumie.example/pair?k=abc');
		const container = document.createElement('div');
		const svg = renderQrCode(container, code, { quietZone: 2 });

		assert.strictEqual(svg.getAttribute('viewBox'), `0 0 ${code.size + 4} ${code.size + 4}`);

		const path = svg.querySelector('.agent-settings-qr-modules');
		assert.ok(path, 'expected one path carrying every dark module');

		const drawn: boolean[][] = [];
		for (let y = 0; y < code.size; y++) {
			drawn.push(new Array<boolean>(code.size).fill(false));
		}
		let runs = 0;
		for (const run of (path.getAttribute('d') ?? '').matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
			runs++;
			const x = Number(run[1]) - 2;
			const y = Number(run[2]) - 2;
			const width = Number(run[3]);
			assert.ok(y >= 0 && y < code.size, `a run at row ${y} would sit in the quiet zone`);
			assert.ok(x >= 0 && x + width <= code.size, `a run at ${x}+${width} would sit in the quiet zone`);
			for (let i = 0; i < width; i++) {
				drawn[y][x + i] = true;
			}
		}
		assert.ok(runs > 0, 'expected the path to draw something');
		assert.deepStrictEqual(drawn, code.modules);
	});
});
