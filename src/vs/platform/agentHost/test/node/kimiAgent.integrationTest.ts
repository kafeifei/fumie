/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from '../../../../base/common/path.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import type { InitializeResult } from '../../common/state/sessionProtocol.js';
import type { ListSessionsResult } from '../../common/state/protocol/commands.js';
import { PROTOCOL_VERSION } from '../../common/state/protocol/version/registry.js';
import { ROOT_STATE_URI, type RootState } from '../../common/state/sessionState.js';
import { IServerHandle, startRealServer, stopServer, TestProtocolClient } from './serverIntegrationTestHelpers.js';

const KimiSdkRoot = process.env['VSCODE_AGENT_HOST_KIMI_TEST_SDK_ROOT'];

(KimiSdkRoot ? suite : suite.skip)('Kimi Agent Host integration', function () {
	let server: IServerHandle;
	let client: TestProtocolClient;
	let homeDir: string;
	let userDataDir: string;

	suiteSetup(async function () {
		this.timeout(30_000);
		homeDir = mkdtempSync(join(tmpdir(), 'fumie-kimi-test-home-'));
		userDataDir = mkdtempSync(join(tmpdir(), 'fumie-kimi-test-data-'));
		server = await startRealServer({
			kimiSdkRoot: KimiSdkRoot!,
			homeDir,
			userDataDir,
			env: {
				OPENAI_BASE_URL: 'http://127.0.0.1:1',
				OPENAI_API_KEY: 'integration-test-key',
			},
		});
	});

	suiteTeardown(async function () {
		this.timeout(20_000);
		await stopServer(server);
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(userDataDir, { recursive: true, force: true });
	});

	setup(async () => {
		client = new TestProtocolClient(server.port);
		await client.connect();
	});

	teardown(() => client.close());

	test('registers Kimi and loads the packaged SDK for session listing', async function () {
		this.timeout(20_000);
		const initialized = await client.call<InitializeResult>('initialize', {
			channel: ROOT_STATE_URI,
			protocolVersions: [PROTOCOL_VERSION],
			clientId: 'kimi-sdk-smoke',
			initialSubscriptions: [ROOT_STATE_URI],
		});
		const root = initialized.snapshots.find(snapshot => snapshot.resource === ROOT_STATE_URI)?.state as RootState | undefined;
		const kimi = root?.agents.find(agent => agent.provider === 'kimi');
		assert.ok(kimi, 'Kimi provider should be advertised');
		assert.deepStrictEqual(kimi.models.map(model => model.id), []);
		assert.deepStrictEqual(kimi.protectedResources, undefined);

		const listed = await client.call<ListSessionsResult>('listSessions', { channel: ROOT_STATE_URI });
		assert.deepStrictEqual(listed.items.filter(item => item.provider === 'kimi'), []);
	});
});
