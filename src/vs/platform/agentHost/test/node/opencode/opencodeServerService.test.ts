/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { RequestListener } from 'http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { requestOpencode } from '../../../node/opencode/opencodeServerService.js';

suite('Opencode HTTP turn lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// This suite runs serially: changing the dispatcher models the ordinary
	// HTTP timeout without waiting five minutes for each regression check.
	async function withServer(handler: RequestListener, run: (baseUrl: string) => Promise<void>): Promise<void> {
		const previousDispatcher = getGlobalDispatcher();
		const dispatcher = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
		const { createServer } = await import('http');
		const server = createServer(handler);
		try {
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			setGlobalDispatcher(dispatcher);
			await run(`http://127.0.0.1:${address.port}`);
		} finally {
			setGlobalDispatcher(previousDispatcher);
			await dispatcher.destroy();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	test('waits for a turn past the default response header and body timeouts', async function () {
		this.timeout(10_000);
		await withServer((request, response) => {
			assert.strictEqual(request.method, 'POST');
			assert.strictEqual(request.url, '/session/long-turn/message');
			// Undici checks short timeouts on a coarse timer; exceed its tick.
			const headers = setTimeout(() => {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.write('{"finished":');
				const body = setTimeout(() => response.end('true}'), 1500);
				response.once('close', () => clearTimeout(body));
			}, 1500);
			response.once('close', () => clearTimeout(headers));
		}, async baseUrl => {
			assert.deepStrictEqual(await requestOpencode(baseUrl, 'Basic test', 'POST', '/session/long-turn/message', { parts: [] }), { finished: true });
		});
	});

	test('retains the default timeout for ordinary GET requests', async function () {
		this.timeout(5000);
		await withServer((_request, _response) => { }, async baseUrl => {
			await assert.rejects(requestOpencode(baseUrl, 'Basic test', 'GET', '/session/status'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
		});
	});

	test('still aborts a long turn when its cancellation signal fires', async () => {
		const controller = new AbortController();
		await withServer((_request, _response) => controller.abort(), async baseUrl => {
			await assert.rejects(requestOpencode(baseUrl, 'Basic test', 'POST', '/session/cancel-turn/message', { parts: [] }, controller.signal), { name: 'AbortError' });
		});
	});
});
