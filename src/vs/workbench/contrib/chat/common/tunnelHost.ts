/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IMobileClientInfo, ITunnelHostInfo } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ITunnelHostService = createDecorator<ITunnelHostService>('tunnelHostService');

export interface ITunnelHostService {
	readonly _serviceBrand: undefined;

	/** Fires when the sharing status changes. */
	readonly onDidChangeStatus: Event<void>;

	/** Whether the agent host is currently shared via a tunnel. */
	readonly isSharing: boolean;

	/** Whether a tunnel connection is currently being established. */
	readonly isConnecting: boolean;

	/** Information about the active tunnel, if sharing. */
	readonly sharingInfo: ITunnelHostInfo | undefined;

	/** Start sharing the local agent host via a dev tunnel. */
	startSharing(): Promise<void>;

	/** Stop sharing and tear down the tunnel. */
	stopSharing(): Promise<void>;

	/**
	 * Replace the secret in the address a phone opens, so every address handed
	 * out before now stops working. Works whether or not sharing is on.
	 */
	rollPhonePairing(): Promise<void>;

	/**
	 * Fires with the whole list whenever a client connects, reconnects or goes
	 * away, so a rendered list can be replaced from the event alone.
	 */
	readonly onDidChangeClients: Event<readonly IMobileClientInfo[]>;

	/**
	 * The devices currently connected to this machine's mobile web server.
	 * Empty when nothing is hosted, and on any client that cannot host.
	 */
	listClients(): Promise<readonly IMobileClientInfo[]>;

	/**
	 * Close one client's connection and revoke the session it was holding, so
	 * the reconnect its page attempts is refused rather than resumed.
	 *
	 * Not a ban: a device that still has the link can open it again and be let
	 * back in. Taking the link itself back is {@link rollPhonePairing}. Unknown
	 * ids are ignored — a client that left on its own between the list being
	 * rendered and the button being pressed is the common case.
	 */
	disconnectClient(id: string): Promise<void>;
}
