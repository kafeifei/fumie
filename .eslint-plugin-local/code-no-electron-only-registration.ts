/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TSESTree } from '@typescript-eslint/utils';
import * as eslint from 'eslint';
import type * as ESTree from 'estree';
import { dirname, join, normalize, relative } from 'path';

const REPO_ROOT = normalize(join(import.meta.dirname, '../'));

/**
 * Flags a top-level registration made from an Electron-only or Node-only file for a class that
 * is not itself Electron-only. The Agents window has two entry points that each import their own
 * registration files, so a platform-neutral contribution or service registered from an
 * `electron-browser/` file is registered on desktop and nowhere else: it compiles, the desktop app
 * works, and the web build silently loses the feature.
 *
 * Configure the rule's reach through the `files` glob in `eslint.config.js`; the rule itself
 * assumes it is only run on files in an Electron-only or Node-only directory. The `neutralRoot`
 * option names the tree whose `browser/` and `common/` code is expected to serve both entry
 * points.
 *
 * Two shapes are reported:
 *
 * - the registered class is imported from a `browser/` or `common/` module under `neutralRoot` —
 *   it is platform-neutral by construction, because layering forbids those directories from
 *   importing Electron code;
 * - the registered class is declared in this file, its constructor injects no platform-specific
 *   service, and its body references nothing imported from an Electron-only or Node-only module.
 *
 * Known limits, all of which bias towards not reporting:
 *
 * - only registrations whose class argument is a plain identifier are considered, so a
 *   `new SyncDescriptor(...)` or an inline anonymous class is skipped;
 * - a platform-neutral class can still be wanted on desktop only, because its sole consumer is
 *   Electron-only. That is the usual shape outside `neutralRoot` — `AgentHostByokLmHandler` is
 *   pure browser code whose only consumer is created in
 *   `platform/agentHost/electron-browser/localAgentHostService.ts` — which is why an imported
 *   class is judged by where it lives rather than by what it contains, and why the same shape
 *   inside `neutralRoot` is not exempt;
 * - for an imported class only the layer of its defining module is consulted, not its source. A
 *   class under `browser/` that injects a native service through a `common/` decorator would be
 *   reported; the fix is the same either way — such a class belongs in the Electron directory
 *   that registers it;
 * - the body scan is textual, so a class that only mentions an Electron import inside a comment
 *   counts as Electron-dependent;
 * - the rule says nothing about whether the web entry actually imports the `browser/` file that a
 *   registration moves to. `src/vs/sessions/test/browser/webEntry.smoke.ts` covers that half.
 */
export default new class implements eslint.Rule.RuleModule {

	readonly meta: eslint.Rule.RuleMetaData = {
		messages: {
			importedNeutralClass: '{{name}} is defined in platform-neutral code ({{module}}), so registering it here registers it for the desktop entry only. Move the registration to a browser/ file that both entry points import.',
			localNeutralClass: '{{name}} injects no platform-specific service and uses no Electron-only import, so registering it here registers it for the desktop entry only. Move the class and its registration to a browser/ file that both entry points import.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					neutralRoot: { type: 'string' },
				},
				required: ['neutralRoot'],
				additionalProperties: false,
			}
		],
	};

	create(context: eslint.Rule.RuleContext): eslint.Rule.RuleListener {

		const neutralRoot = (context.options[0] as { neutralRoot: string }).neutralRoot;

		/** Argument position holding the registered class, per registration function. */
		const registrationArgument = new Map<string, number>([
			['registerSingleton', 1],
			['registerWorkbenchContribution2', 1],
			['registerWorkbenchContribution', 0],
			['registerAction2', 0],
		]);
		const platformLayer = /(^|\/)(electron-browser|electron-main|electron-utility|node)\//;
		const neutralLayer = /(^|\/)(browser|common)\//;
		// Services whose decorator lives in a neutral directory but whose implementation is native.
		const nativeService = /^I(Native|MainProcess|SharedProcess|Electron)/;

		/** Local name -> module the name was imported from, as a repo-ish path. */
		const importedFrom = new Map<string, string>();
		const classes = new Map<string, TSESTree.ClassDeclaration>();

		function resolveModule(specifier: string): string {
			if (!specifier.startsWith('.')) {
				return specifier;
			}
			return relative(REPO_ROOT, join(dirname(context.filename), specifier)).replace(/\\/g, '/');
		}

		/** Whether the class can only run on Electron, and so belongs where it is. */
		function isPlatformSpecific(node: TSESTree.ClassDeclaration): boolean {
			const text = context.sourceCode.getText(node as ESTree.Node);
			for (const [name, module] of importedFrom) {
				if (platformLayer.test(module) && new RegExp(`\\b${name}\\b`).test(text)) {
					return true;
				}
			}
			for (const member of node.body.body) {
				if (member.type !== 'MethodDefinition' || member.kind !== 'constructor') {
					continue;
				}
				for (const parameter of member.value.params) {
					for (const decorator of parameter.decorators ?? []) {
						if (decorator.expression.type === 'Identifier' && nativeService.test(decorator.expression.name)) {
							return true;
						}
					}
				}
			}
			return false;
		}

		return {
			ImportDeclaration(node: ESTree.ImportDeclaration) {
				if (typeof node.source.value !== 'string') {
					return;
				}
				for (const specifier of node.specifiers) {
					importedFrom.set(specifier.local.name, resolveModule(node.source.value));
				}
			},
			ClassDeclaration(node: ESTree.ClassDeclaration) {
				if (node.id) {
					classes.set(node.id.name, node as TSESTree.ClassDeclaration);
				}
			},
			'Program:exit'(program: ESTree.Program) {
				for (const statement of program.body) {
					if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') {
						continue;
					}
					const call = statement.expression;
					if (call.callee.type !== 'Identifier') {
						continue;
					}
					const index = registrationArgument.get(call.callee.name);
					if (index === undefined) {
						continue;
					}
					const argument = call.arguments[index];
					if (argument?.type !== 'Identifier') {
						continue;
					}

					const module = importedFrom.get(argument.name);
					if (module !== undefined) {
						if (module.startsWith(neutralRoot) && neutralLayer.test(module) && !platformLayer.test(module)) {
							context.report({
								node: argument,
								messageId: 'importedNeutralClass',
								data: { name: argument.name, module },
							});
						}
						continue;
					}

					const declaration = classes.get(argument.name);
					if (declaration && !isPlatformSpecific(declaration)) {
						context.report({
							node: argument,
							messageId: 'localNeutralClass',
							data: { name: argument.name },
						});
					}
				}
			},
		};
	}
};
