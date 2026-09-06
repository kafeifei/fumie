/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../base/common/errors.js';

/**
 * A cancelled send whose message never reached the harness. Providers must
 * report this only at a proven pre-submission boundary, not infer it from
 * missing output. The host owns the cancelled turn absent from SDK history.
 * This is an in-process provider fact, not an AHP error or a retry request.
 */
export class AgentMessageNotSubmittedError extends CancellationError { }
