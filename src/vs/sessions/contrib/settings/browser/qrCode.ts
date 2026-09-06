/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';

/**
 * A QR code encoder, in the product rather than behind an image service.
 *
 * The only thing this ever encodes is the address another device uses to reach
 * this machine, and that address is a capability: whoever holds it holds the
 * access it grants. So the string must not be handed to a generator API, and a
 * `<img src="https://…/qr?data=">` is exactly that. This is the whole of
 * ISO/IEC 18004 that byte mode at error correction level M needs — nothing
 * leaves the process.
 */

// --- Tables ------------------------------------------------------------------

/** Error correction level M — the code still reads with ~15% of it lost. */
const EC_LEVEL_FORMAT_BITS = 0b00;

/** Error correction codewords per block at level M, indexed by version - 1. */
const EC_CODEWORDS_PER_BLOCK = [
	10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
	30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
	26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Error correction blocks at level M, indexed by version - 1. */
const EC_BLOCKS = [
	1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
	5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
	17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
	31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Byte mode. */
const MODE_INDICATOR = 0b0100;

/** The pad codewords the spec names, alternating, once the data runs out. */
const PAD_CODEWORDS = [0xEC, 0x11];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** The spec's minimum blank margin; below it a reader cannot find the code. */
export const QR_QUIET_ZONE_MODULES = 4;

// --- Public shape ------------------------------------------------------------

export interface IQrCode {
	/** 1-40. Fixes both the size and how much the code holds. */
	readonly version: number;
	/** Modules per side, quiet zone excluded: `version * 4 + 17`. */
	readonly size: number;
	/** 0-7. The pattern XOR'd over the data, recorded in the format bits. */
	readonly mask: number;
	/** `modules[y][x]` is true where the module is dark. */
	readonly modules: readonly (readonly boolean[])[];
}

export interface IQrCodeRenderOptions {
	readonly quietZone?: number;
	readonly ariaLabel?: string;
	/** Hover text; the address itself, which the card no longer spells out. */
	readonly title?: string;
}

// --- Encoding ----------------------------------------------------------------

/**
 * Encode `text` as a byte-mode, level-M QR code at the smallest version that
 * holds it, or `undefined` when no version does (the level-M ceiling is 2331
 * UTF-8 bytes). Callers render a plain link instead rather than a broken code.
 */
export function encodeQrCode(text: string): IQrCode | undefined {
	const bytes = new TextEncoder().encode(text);
	const version = selectVersion(bytes.length);
	if (version === undefined) {
		return undefined;
	}
	return buildQrCode(version, addErrorCorrection(version, dataCodewords(version, bytes)));
}

/** The smallest version whose level-M data capacity holds `byteCount` bytes. */
export function selectVersion(byteCount: number): number | undefined {
	for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
		const capacity = dataCodewordCount(version) * 8;
		if (4 + characterCountBits(version) + byteCount * 8 <= capacity) {
			return version;
		}
	}
	return undefined;
}

/** Modules available to data and error correction, as whole codewords. */
function rawCodewordCount(version: number): number {
	let modules = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const alignmentCount = Math.floor(version / 7) + 2;
		modules -= (25 * alignmentCount - 10) * alignmentCount - 55;
		if (version >= 7) {
			modules -= 36;
		}
	}
	return Math.floor(modules / 8);
}

function dataCodewordCount(version: number): number {
	return rawCodewordCount(version) - EC_CODEWORDS_PER_BLOCK[version - 1] * EC_BLOCKS[version - 1];
}

function characterCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

/** Mode, length, payload, terminator and padding, packed into codewords. */
function dataCodewords(version: number, bytes: Uint8Array): Uint8Array {
	const capacity = dataCodewordCount(version) * 8;
	const bits: number[] = [];
	appendBits(bits, MODE_INDICATOR, 4);
	appendBits(bits, bytes.length, characterCountBits(version));
	for (const byte of bytes) {
		appendBits(bits, byte, 8);
	}
	appendBits(bits, 0, Math.min(4, capacity - bits.length));
	appendBits(bits, 0, (8 - bits.length % 8) % 8);

	const codewords = new Uint8Array(capacity / 8);
	for (let i = 0; i < bits.length; i++) {
		codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
	}
	const padFrom = bits.length / 8;
	for (let i = padFrom; i < codewords.length; i++) {
		codewords[i] = PAD_CODEWORDS[(i - padFrom) % PAD_CODEWORDS.length];
	}
	return codewords;
}

function appendBits(bits: number[], value: number, count: number): void {
	for (let i = count - 1; i >= 0; i--) {
		bits.push((value >>> i) & 1);
	}
}

/**
 * Split the data into the version's blocks, give each its Reed-Solomon
 * codewords, then interleave: a scratch on the printed code then damages one
 * codeword of many blocks rather than wiping out one block entirely.
 */
function addErrorCorrection(version: number, data: Uint8Array): Uint8Array {
	const blockCount = EC_BLOCKS[version - 1];
	const ecLength = EC_CODEWORDS_PER_BLOCK[version - 1];
	const generator = generatorPolynomial(ecLength);
	const shortLength = Math.floor(data.length / blockCount);
	const shortCount = blockCount - data.length % blockCount;

	const dataBlocks: Uint8Array[] = [];
	const ecBlocks: Uint8Array[] = [];
	for (let i = 0, offset = 0; i < blockCount; i++) {
		const length = shortLength + (i < shortCount ? 0 : 1);
		const block = data.subarray(offset, offset + length);
		offset += length;
		dataBlocks.push(block);
		ecBlocks.push(remainder(block, generator));
	}

	const result = new Uint8Array(rawCodewordCount(version));
	let at = 0;
	for (let i = 0; i < shortLength + 1; i++) {
		for (const block of dataBlocks) {
			if (i < block.length) {
				result[at++] = block[i];
			}
		}
	}
	for (let i = 0; i < ecLength; i++) {
		for (const block of ecBlocks) {
			result[at++] = block[i];
		}
	}
	return result;
}

// --- GF(256) -----------------------------------------------------------------

const GF_EXP = buildExponentials();
const GF_LOG = buildLogarithms(GF_EXP);

/** Powers of 2 in GF(256) modulo the QR primitive polynomial x^8+x^4+x^3+x^2+1. */
function buildExponentials(): Uint8Array {
	const table = new Uint8Array(512);
	let value = 1;
	for (let i = 0; i < 255; i++) {
		table[i] = value;
		value <<= 1;
		if (value & 0x100) {
			value ^= 0x11D;
		}
	}
	// Doubled so `GF_EXP[logA + logB]` never needs a modulo.
	for (let i = 255; i < 512; i++) {
		table[i] = table[i - 255];
	}
	return table;
}

function buildLogarithms(exponentials: Uint8Array): Uint8Array {
	const table = new Uint8Array(256);
	for (let i = 0; i < 255; i++) {
		table[exponentials[i]] = i;
	}
	return table;
}

function multiply(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** `(x - 2^0)(x - 2^1)…`, highest degree first, monic. */
function generatorPolynomial(degree: number): Uint8Array {
	let result = Uint8Array.of(1);
	for (let i = 0; i < degree; i++) {
		const next = new Uint8Array(result.length + 1);
		for (let j = 0; j < result.length; j++) {
			next[j] ^= result[j];
			next[j + 1] ^= multiply(result[j], GF_EXP[i]);
		}
		result = next;
	}
	return result;
}

/** `data * x^degree mod generator` — the error correction codewords. */
function remainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
	const degree = generator.length - 1;
	const result = new Uint8Array(degree);
	for (const byte of data) {
		const factor = byte ^ result[0];
		result.copyWithin(0, 1);
		result[degree - 1] = 0;
		for (let i = 0; i < degree; i++) {
			result[i] ^= multiply(generator[i + 1], factor);
		}
	}
	return result;
}

// --- Matrix ------------------------------------------------------------------

interface IQrMatrix {
	readonly size: number;
	readonly modules: boolean[][];
	/** Function patterns are not masked and carry no data. */
	readonly isFunction: boolean[][];
}

function buildQrCode(version: number, codewords: Uint8Array): IQrCode {
	const size = version * 4 + 17;
	const matrix: IQrMatrix = { size, modules: newGrid(size), isFunction: newGrid(size) };
	drawFunctionPatterns(matrix, version);
	drawCodewords(matrix, codewords);

	// The mask is chosen by the spec's penalty rules, and the format bits have
	// to name the one actually applied — so both are written together, and the
	// XOR is undone before trying the next.
	let mask = 0;
	let best = Number.POSITIVE_INFINITY;
	for (let candidate = 0; candidate < 8; candidate++) {
		applyMask(matrix, candidate);
		drawFormatBits(matrix, candidate);
		const penalty = penaltyScore(matrix);
		if (penalty < best) {
			best = penalty;
			mask = candidate;
		}
		applyMask(matrix, candidate);
	}
	applyMask(matrix, mask);
	drawFormatBits(matrix, mask);

	return { version, size, mask, modules: matrix.modules };
}

function newGrid(size: number): boolean[][] {
	const grid: boolean[][] = [];
	for (let y = 0; y < size; y++) {
		grid.push(new Array<boolean>(size).fill(false));
	}
	return grid;
}

function setFunctionModule(matrix: IQrMatrix, x: number, y: number, dark: boolean): void {
	matrix.modules[y][x] = dark;
	matrix.isFunction[y][x] = true;
}

function drawFunctionPatterns(matrix: IQrMatrix, version: number): void {
	const size = matrix.size;

	for (let i = 0; i < size; i++) {
		setFunctionModule(matrix, 6, i, i % 2 === 0);
		setFunctionModule(matrix, i, 6, i % 2 === 0);
	}

	drawFinderPattern(matrix, 3, 3);
	drawFinderPattern(matrix, size - 4, 3);
	drawFinderPattern(matrix, 3, size - 4);

	const positions = alignmentPatternPositions(version);
	for (let i = 0; i < positions.length; i++) {
		for (let j = 0; j < positions.length; j++) {
			// The three corners are already finder patterns.
			const corner = (i === 0 && j === 0)
				|| (i === 0 && j === positions.length - 1)
				|| (i === positions.length - 1 && j === 0);
			if (!corner) {
				drawAlignmentPattern(matrix, positions[i], positions[j]);
			}
		}
	}

	// Reserved now so the data never lands here; rewritten once the mask is known.
	drawFormatBits(matrix, 0);
	drawVersionBits(matrix, version);
}

/** The 7x7 eye plus its separator, clipped at the edges of the code. */
function drawFinderPattern(matrix: IQrMatrix, centerX: number, centerY: number): void {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const x = centerX + dx;
			const y = centerY + dy;
			if (x < 0 || x >= matrix.size || y < 0 || y >= matrix.size) {
				continue;
			}
			const ring = Math.max(Math.abs(dx), Math.abs(dy));
			setFunctionModule(matrix, x, y, ring !== 2 && ring !== 4);
		}
	}
}

function drawAlignmentPattern(matrix: IQrMatrix, centerX: number, centerY: number): void {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			setFunctionModule(matrix, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}
}

function alignmentPatternPositions(version: number): number[] {
	if (version === 1) {
		return [];
	}
	const count = Math.floor(version / 7) + 2;
	// Version 32 is the one the spacing formula does not produce.
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
	const positions = [6];
	for (let pos = version * 4 + 10; positions.length < count; pos -= step) {
		positions.splice(1, 0, pos);
	}
	return positions;
}

/**
 * The 15 format bits — error correction level and mask — as a BCH(15,5) word,
 * written twice so losing one finder corner does not cost the reader the mask.
 */
function drawFormatBits(matrix: IQrMatrix, mask: number): void {
	const size = matrix.size;
	const data = (EC_LEVEL_FORMAT_BITS << 3) | mask;
	let rest = data;
	for (let i = 0; i < 10; i++) {
		rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
	}
	const bits = ((data << 10) | rest) ^ 0x5412;

	for (let i = 0; i <= 5; i++) {
		setFunctionModule(matrix, 8, i, getBit(bits, i));
	}
	setFunctionModule(matrix, 8, 7, getBit(bits, 6));
	setFunctionModule(matrix, 8, 8, getBit(bits, 7));
	setFunctionModule(matrix, 7, 8, getBit(bits, 8));
	for (let i = 9; i < 15; i++) {
		setFunctionModule(matrix, 14 - i, 8, getBit(bits, i));
	}

	for (let i = 0; i < 8; i++) {
		setFunctionModule(matrix, size - 1 - i, 8, getBit(bits, i));
	}
	for (let i = 8; i < 15; i++) {
		setFunctionModule(matrix, 8, size - 15 + i, getBit(bits, i));
	}
	// The dark module: always set, at every version.
	setFunctionModule(matrix, 8, size - 8, true);
}

/** From version 7 the size is no longer inferable from the finders alone. */
function drawVersionBits(matrix: IQrMatrix, version: number): void {
	if (version < 7) {
		return;
	}
	let rest = version;
	for (let i = 0; i < 12; i++) {
		rest = (rest << 1) ^ ((rest >>> 11) * 0x1F25);
	}
	const bits = (version << 12) | rest;
	for (let i = 0; i < 18; i++) {
		const dark = getBit(bits, i);
		const far = matrix.size - 11 + i % 3;
		const near = Math.floor(i / 3);
		setFunctionModule(matrix, far, near, dark);
		setFunctionModule(matrix, near, far, dark);
	}
}

/** The zigzag: two-module columns, right to left, alternating up and down. */
function drawCodewords(matrix: IQrMatrix, codewords: Uint8Array): void {
	const size = matrix.size;
	const total = codewords.length * 8;
	let bit = 0;
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
				if (!matrix.isFunction[y][x] && bit < total) {
					matrix.modules[y][x] = getBit(codewords[bit >>> 3], 7 - (bit & 7));
					bit++;
				}
			}
		}
	}
}

/** XOR is its own inverse, so this both applies and removes a mask. */
function applyMask(matrix: IQrMatrix, mask: number): void {
	for (let y = 0; y < matrix.size; y++) {
		for (let x = 0; x < matrix.size; x++) {
			if (!matrix.isFunction[y][x] && maskAt(mask, x, y)) {
				matrix.modules[y][x] = !matrix.modules[y][x];
			}
		}
	}
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

/**
 * The spec's four penalty rules. A lower score is a code a reader has an easier
 * time with; which mask wins does not affect correctness, only legibility.
 */
function penaltyScore(matrix: IQrMatrix): number {
	const { size, modules } = matrix;
	let result = 0;

	for (let y = 0; y < size; y++) {
		let runDark = false;
		let runLength = 0;
		const history = [0, 0, 0, 0, 0, 0, 0];
		for (let x = 0; x < size; x++) {
			if (modules[y][x] === runDark) {
				runLength++;
				if (runLength === 5) {
					result += PENALTY_N1;
				} else if (runLength > 5) {
					result++;
				}
			} else {
				addRun(history, runLength, size);
				if (!runDark) {
					result += countFinderLike(history) * PENALTY_N3;
				}
				runDark = modules[y][x];
				runLength = 1;
			}
		}
		result += terminateRuns(history, runDark, runLength, size) * PENALTY_N3;
	}

	for (let x = 0; x < size; x++) {
		let runDark = false;
		let runLength = 0;
		const history = [0, 0, 0, 0, 0, 0, 0];
		for (let y = 0; y < size; y++) {
			if (modules[y][x] === runDark) {
				runLength++;
				if (runLength === 5) {
					result += PENALTY_N1;
				} else if (runLength > 5) {
					result++;
				}
			} else {
				addRun(history, runLength, size);
				if (!runDark) {
					result += countFinderLike(history) * PENALTY_N3;
				}
				runDark = modules[y][x];
				runLength = 1;
			}
		}
		result += terminateRuns(history, runDark, runLength, size) * PENALTY_N3;
	}

	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const dark = modules[y][x];
			if (dark === modules[y][x + 1] && dark === modules[y + 1][x] && dark === modules[y + 1][x + 1]) {
				result += PENALTY_N2;
			}
		}
	}

	let dark = 0;
	for (const row of modules) {
		for (const module of row) {
			if (module) {
				dark++;
			}
		}
	}
	const total = size * size;
	const imbalance = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	return result + imbalance * PENALTY_N4;
}

function addRun(history: number[], runLength: number, size: number): void {
	// The quiet zone counts as light for the run that touches the edge.
	const length = history[0] === 0 ? runLength + size : runLength;
	history.pop();
	history.unshift(length);
}

function terminateRuns(history: number[], runDark: boolean, runLength: number, size: number): number {
	let length = runLength;
	if (runDark) {
		addRun(history, length, size);
		length = 0;
	}
	addRun(history, length + size, size);
	return countFinderLike(history);
}

/** Runs in 1:1:3:1:1 proportion with a wide light margin — the finder's signature. */
function countFinderLike(history: number[]): number {
	const unit = history[1];
	const core = unit > 0
		&& history[2] === unit
		&& history[3] === unit * 3
		&& history[4] === unit
		&& history[5] === unit;
	return (core && history[0] >= unit * 4 && history[6] >= unit ? 1 : 0)
		+ (core && history[6] >= unit * 4 && history[0] >= unit ? 1 : 0);
}

function getBit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0;
}

// --- Rendering ---------------------------------------------------------------

/**
 * Draw `code` as an SVG: one plate and one path, rather than a node per module
 * — a version 7 code is 2025 of them. Both take their colour from CSS, so the
 * theme owns the contrast the reader depends on.
 */
export function renderQrCode(parent: HTMLElement, code: IQrCode, options?: IQrCodeRenderOptions): SVGElement {
	const quietZone = options?.quietZone ?? QR_QUIET_ZONE_MODULES;
	const extent = code.size + quietZone * 2;

	// `class` goes through `setAttribute`: an SVG element's `className` is read
	// only, so it must not be spelled into the selector `$.SVG` parses.
	const svg = DOM.$.SVG<SVGSVGElement>('svg', {
		class: 'agent-settings-qr-svg',
		viewBox: `0 0 ${extent} ${extent}`,
		// Modules are squares on a whole-number grid; anti-aliasing them costs contrast.
		'shape-rendering': 'crispEdges',
		role: 'img',
		'aria-label': options?.ariaLabel,
	});
	if (options?.title) {
		svg.appendChild(DOM.$.SVG('title', undefined, options.title));
	}
	svg.appendChild(DOM.$.SVG('rect', {
		class: 'agent-settings-qr-plate',
		x: '0',
		y: '0',
		width: `${extent}`,
		height: `${extent}`,
	}));
	svg.appendChild(DOM.$.SVG('path', {
		class: 'agent-settings-qr-modules',
		d: modulePath(code, quietZone),
	}));

	parent.appendChild(svg);
	return svg;
}

/** Horizontal runs of dark modules, as one path. */
function modulePath(code: IQrCode, quietZone: number): string {
	const parts: string[] = [];
	for (let y = 0; y < code.size; y++) {
		const row = code.modules[y];
		for (let x = 0; x < code.size; x++) {
			if (!row[x]) {
				continue;
			}
			let run = 1;
			while (x + run < code.size && row[x + run]) {
				run++;
			}
			parts.push(`M${x + quietZone} ${y + quietZone}h${run}v1h-${run}z`);
			x += run - 1;
		}
	}
	return parts.join('');
}
