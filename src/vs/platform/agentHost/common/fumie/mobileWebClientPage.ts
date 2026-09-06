/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The page Fumie serves to a browser that is driving this machine — a phone over
 * a tunnel, or the preview harness on loopback. It is one client, so it is one
 * file.
 *
 * Two servers hand this page out and they build their assets differently: the
 * shipped app serves a prebuilt, minified `web-bundle`, while
 * `scripts/mobile-agent-preview/server.ts` serves the raw `out/` tree with a
 * throwaway esbuild bundle over it. Only that asset layout differs, so only it
 * is a parameter; every line of boot and failure-reporting logic below is shared.
 * Keeping two copies of this script had already shipped two defects — the
 * preview never got the post-boot error banner, and its bundle went stale — so
 * the copies are gone and neither server owns a template of its own.
 *
 * This module deliberately imports nothing. The preview harness runs as
 * CommonJS under `--experimental-strip-types` (`scripts/package.json` is
 * `{"type":"commonjs"}`) and cannot resolve the `.js` specifiers that `src/vs`
 * modules use, so it loads the compiled `out/` copy of this file by URL. That
 * only stays possible while this file has no dependency chain to follow.
 */

export interface IMobileWebClientPageOptions {

	/**
	 * Path, relative to the page's own origin, that `_VSCODE_FILE_ROOT` points
	 * at. The workbench resolves lazily-loaded node modules against it as
	 * `vs/../../node_modules/...`, so whatever serves this path must also serve
	 * a sibling `node_modules/` — otherwise xterm and katex 404 at runtime.
	 */
	readonly fileRootPath: string;

	/** Path to the workbench stylesheet. */
	readonly stylesheetPath: string;

	/** Path to the workbench ES module whose `create` boots the client. */
	readonly modulePath: string;

	/** Path the client opens its agent host WebSocket on. */
	readonly agentHostPath: string;

	readonly nameShort: string;
	readonly nameLong: string;

	/**
	 * Settings merged over the defaults every client needs. The preview harness
	 * uses this to agree with the environment it starts its own agent host in;
	 * the shipped app needs nothing extra.
	 */
	readonly configurationDefaults?: Readonly<Record<string, unknown>>;
}

/**
 * Render the client page. Pure: the same options always produce the same bytes,
 * which is what lets a test hold the two servers' pages against each other.
 */
export function renderMobileWebClientPage(options: IMobileWebClientPageOptions): string {
	const extraConfigurationDefaults = JSON.stringify(options.configurationDefaults ?? {});
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<title>${options.nameShort}</title>
	<link rel="stylesheet" href="${options.stylesheetPath}" />
	<script>
		globalThis._VSCODE_FILE_ROOT = location.origin + '${options.fileRootPath}';
	</script>
</head>
<body aria-label="">
	<!-- allow-any-unicode-next-line -->
	<div id="fumie-mobile-startup" style="box-sizing:border-box;min-height:100vh;padding:32px 24px;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#59636e;text-align:center">正在连接 Fumie…</div>
	<script type="module">
		const startup = document.getElementById('fumie-mobile-startup');
		const agentHostAddress =
			(location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '${options.agentHostPath}';

		// Every sentence this page can put on its own screen, in one place so
		// they can be read as a set. Chinese for the line the user reads,
		// English for the technical half underneath it — the split the page
		// already used, and the half that gets forwarded to someone else.
		// allow-any-unicode-next-line
		const SENTENCE_BOOT = 'Fumie 手机端启动失败';
		// allow-any-unicode-next-line
		const SENTENCE_CLIENT = '刚才那一步没成功';
		// allow-any-unicode-next-line
		const SENTENCE_BRIDGE = 'Fumie 连不上这台电脑';
		// allow-any-unicode-next-line
		const LABEL_DETAIL = '详情';
		// allow-any-unicode-next-line
		const LABEL_COLLAPSE = '收起';
		// allow-any-unicode-next-line
		const LABEL_LOG = '日志';
		// allow-any-unicode-next-line
		const LABEL_LOG_TITLE = 'Fumie 手机端日志';
		// allow-any-unicode-next-line
		const LABEL_COPY = '复制';
		// allow-any-unicode-next-line
		const LABEL_COPIED = '已复制';
		// allow-any-unicode-next-line
		const LABEL_COPY_BY_HAND = '长按选中复制';
		// allow-any-unicode-next-line
		const LABEL_CLOSE = '关闭';
		// allow-any-unicode-next-line
		const LABEL_DISMISS = '忽略';
		// allow-any-unicode-next-line
		const repeatSuffix = times => '（共 ' + times + ' 次）';

		// The record. A phone cannot open a console, so anything written only
		// to one does not exist. Everything lands here: what reached the
		// screen, what was deliberately kept off it, the drops that came back,
		// the cancellations. Keeping something off the screen is exactly when
		// this has to hold it — a stack trace is what found the real bug twice
		// — so nothing is dropped for being judged not worth showing.
		//
		// Bounded, because the workbench logs steadily and this page is meant
		// to stay open all day; the newest lines are the ones worth keeping.
		const LOG_LIMIT = 2000;
		const logLines = [];
		const logLine = (kind, text) => {
			logLines.push(new Date().toISOString().slice(11, 23) + ' [' + kind + '] ' + text);
			if (logLines.length > LOG_LIMIT) logLines.shift();
		};
		const logText = () => logLines.join('\\n');

		// What an Event was raised on, which is the whole of its detail. An
		// 'error' Event carries no message by design, so a line that names only
		// its type says nothing a reader can act on: "Event type=error" fits a
		// dead socket, an image the page's own CSP refused, and a script that
		// 404ed, and those want three different fixes. The element and its URL
		// are what tell them apart.
		const describeTarget = target => {
			if (!target) return 'nothing';
			if (target === window) return 'window';
			if (typeof Element !== 'undefined' && target instanceof Element) {
				const tag = target.tagName.toLowerCase();
				const source = target.currentSrc || target.src || target.href;
				return source ? tag + ' ' + source : tag;
			}
			const parts = [(target.constructor && target.constructor.name) || typeof target];
			if (target.url) parts.push(target.url);
			if (target.readyState !== undefined) parts.push('readyState=' + target.readyState);
			return parts.join(' ');
		};

		// A DOM Event has no message and no stack, so coercing one to a string
		// yields "[object Event]" and tells the reader nothing. A failed socket
		// arrives exactly that way: the 'error' event carries no detail by
		// design, and the code and reason are on the 'close' that follows it.
		const describe = value => {
			if (value === null || value === undefined) return String(value);
			if (typeof value === 'string') return value;
			if (value.stack) return value.stack;
			if (value.message) return value.message;
			if (typeof CloseEvent !== 'undefined' && value instanceof CloseEvent) {
				return 'socket closed: code=' + value.code +
					(value.reason ? ', reason=' + value.reason : ', no reason given');
			}
			if (typeof Event !== 'undefined' && value instanceof Event) {
				return value.constructor.name + ' type=' + value.type + ' on ' + describeTarget(value.target);
			}
			try { return JSON.stringify(value); } catch (e) { return String(value); }
		};

		// The workbench writes its own log to the console, and that is the
		// stream that carried the eight "[RemoteAgentHostProtocol] Request N
		// failed" warnings behind opening one session. Tap it on the way past
		// rather than replace it, so a desktop browser still shows exactly
		// what it always did.
		for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
			const original = console[level];
			if (typeof original !== 'function') continue;
			console[level] = function (...args) {
				// ConsoleLogger tags each line with a '%cLEVEL' marker and the
				// CSS to paint it. Keep the label, drop the styling: it is
				// noise in a record that will be read as text.
				const parts = typeof args[0] === 'string' && args[0].startsWith('%c')
					? [args[0].slice(2).trim()].concat(args.slice(2))
					: args;
				logLine(level, parts.map(describe).join(' '));
				return original.apply(console, args);
			};
		}

		const makeButton = label => {
			const button = document.createElement('button');
			button.textContent = label;
			button.style.cssText = 'flex:none;border:0;border-radius:5px;min-height:26px;padding:0 9px;cursor:pointer;'
				+ 'background:rgba(0,0,0,.09);color:inherit;font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif';
			return button;
		};

		// The whole record, on demand. This is the only way the log leaves the
		// phone: copy it, or select it out of the box by hand where the
		// clipboard is not available. Reachable with no failure on screen —
		// add '#log' to the address and go, which changes the hash without
		// reloading, so nothing in flight is lost by looking.
		let logPanel;
		let logBox;
		const openLog = () => {
			if (!logPanel) {
				logPanel = document.createElement('div');
				logPanel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;box-sizing:border-box;'
					+ 'display:flex;flex-direction:column;gap:8px;max-height:70vh;'
					+ 'padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:#f6f8fa;color:#1f2328;'
					+ 'border-top:1px solid #d1d9e0;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif';
				const row = document.createElement('div');
				row.style.cssText = 'display:flex;align-items:center;gap:8px';
				const title = document.createElement('span');
				title.textContent = LABEL_LOG_TITLE;
				title.style.cssText = 'flex:1;min-width:0';
				const copy = makeButton(LABEL_COPY);
				copy.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(logBox.value);
						copy.textContent = LABEL_COPIED;
					} catch (e) {
						// No clipboard permission, or an origin the browser
						// does not call secure. The box is a real textarea for
						// exactly this: select it and say to copy by hand,
						// rather than fail with nothing said.
						logBox.focus();
						logBox.select();
						copy.textContent = LABEL_COPY_BY_HAND;
					}
					setTimeout(() => { copy.textContent = LABEL_COPY; }, 3000);
				});
				const close = makeButton(LABEL_CLOSE);
				close.addEventListener('click', () => {
					logPanel.remove();
					if (location.hash === '#log') location.hash = '';
				});
				row.append(title, copy, close);
				logBox = document.createElement('textarea');
				logBox.readOnly = true;
				logBox.style.cssText = 'flex:1;min-height:30vh;box-sizing:border-box;width:100%;resize:none;'
					+ 'border:1px solid #d1d9e0;border-radius:6px;padding:8px;background:#fff;color:#1f2328;'
					+ 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace';
				logPanel.append(row, logBox);
			}
			logBox.value = logText();
			if (!logPanel.isConnected) document.body.appendChild(logPanel);
		};
		window.addEventListener('hashchange', () => { if (location.hash === '#log') openLog(); });

		// What the screen says: one plain sentence, low and out of the way,
		// with the technical half folded behind the detail control and the whole
		// log one tap further. What used to land here was the raw stack — the
		// ten frames of one failed text-model resolve measure 699px at a 390px
		// width, 83% of an 844px phone — docked over the panel and with it the
		// terminal.
		// A stack is what found the real bug twice, so it is folded, not gone.
		//
		// There is one banner and never a column of them. A cascade, and a
		// failed resolve does cascade, rewrites the same line and raises its
		// count instead of stacking. Nothing is suppressed for being a repeat:
		// not showing a real failure is worse than showing a small one.
		let banner;
		let bannerSentence;
		let bannerCount;
		let bannerDetail;
		let bannerToggle;
		let bannerSource;
		let bannerSeq = 0;
		let bannerRepeats = 0;
		let bannerKey;
		let dismissedKey;
		let dismissedAt = 0;
		const DISMISS_QUIET_MS = 5000;

		// What makes two reports the same one. Every client failure shares a
		// sentence — the page cannot know which step the user was on — so the
		// sentence alone would make one dismissal silence everything that
		// followed it, and a different fault would never be seen.
		const failureKey = (sentence, detail) => sentence + '\\u0000' + detail;

		const setDetailOpen = open => {
			bannerDetail.hidden = !open;
			bannerToggle.textContent = open ? LABEL_COLLAPSE : LABEL_DETAIL;
		};
		const hideBanner = () => {
			if (banner) banner.remove();
			bannerSource = undefined;
		};
		const buildBanner = () => {
			banner = document.createElement('div');
			// Docked over whatever the workbench puts at the bottom of the
			// screen. Collapsed it is a single line; opening the detail grows
			// it to a quarter of the viewport and no further, and scrolls the
			// rest, so a long report can never take the panel with it.
			banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;box-sizing:border-box;'
				+ 'max-height:25vh;overflow:auto;overscroll-behavior:contain;'
				+ 'padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:#fee4e2;color:#7a271a;'
				+ 'font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif';
			const row = document.createElement('div');
			row.style.cssText = 'position:sticky;top:0;display:flex;align-items:center;gap:8px;background:#fee4e2';
			bannerSentence = document.createElement('span');
			bannerSentence.style.cssText = 'flex:1;min-width:0';
			bannerCount = document.createElement('span');
			bannerCount.style.cssText = 'flex:none;opacity:.7;font-size:12px';
			bannerToggle = makeButton(LABEL_DETAIL);
			bannerToggle.addEventListener('click', () => setDetailOpen(bannerDetail.hidden));
			const logButton = makeButton(LABEL_LOG);
			logButton.addEventListener('click', () => openLog());
			// Only a reconnecting bridge ever took the banner down, so a report
			// raised by anything else sat over the panel for the life of the
			// page. Reading it is the point; keeping it afterwards is not, and
			// a phone has no other way to close it.
			const dismiss = makeButton('\\u00d7');
			dismiss.setAttribute('aria-label', LABEL_DISMISS);
			dismiss.addEventListener('click', () => {
				dismissedKey = bannerKey;
				dismissedAt = Date.now();
				hideBanner();
			});
			bannerDetail = document.createElement('pre');
			bannerDetail.hidden = true;
			bannerDetail.style.cssText = 'margin:8px 0 0;white-space:pre-wrap;word-break:break-all;'
				+ 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace';
			row.append(bannerSentence, bannerCount, bannerToggle, logButton, dismiss);
			banner.append(row, bannerDetail);
		};

		/**
		 * Report one failure and answer with a number naming it, so a detail
		 * that only arrives later can be folded into the same report rather
		 * than raising a second one.
		 */
		const showFailure = (sentence, detail, source) => {
			const seq = ++bannerSeq;
			const key = failureKey(sentence, detail);
			// A report the user has just taken down must not spring straight
			// back up: a cascade keeps arriving for seconds after the first of
			// it. Only the raising waits, only for this exact failure — it is
			// written down either way, and anything else comes up at once.
			const justDismissed = key === dismissedKey && Date.now() - dismissedAt < DISMISS_QUIET_MS;
			logLine(justDismissed ? 'failure(held back, just dismissed)' : 'failure', sentence + ' :: ' + detail);
			if (justDismissed) return seq;
			if (!banner) buildBanner();
			if (banner.isConnected && key === bannerKey) {
				bannerRepeats++;
			} else {
				bannerRepeats = 0;
				setDetailOpen(false);
			}
			bannerKey = key;
			bannerSentence.textContent = sentence;
			bannerCount.textContent = bannerRepeats ? repeatSuffix(bannerRepeats + 1) : '';
			bannerDetail.textContent = detail;
			bannerSource = source;
			if (!banner.isConnected) document.body.appendChild(banner);
			return seq;
		};

		/** Fold a detail that arrived late into the report it belongs to. */
		const amendFailure = (seq, extra) => {
			logLine('detail', extra);
			if (seq !== bannerSeq || !banner || !banner.isConnected) return;
			bannerDetail.textContent = bannerDetail.textContent + '\\n\\n' + extra;
		};

		/**
		 * Take down a report raised by one thing, and nothing else: a
		 * reconnecting bridge used to clear the screen of a failure the user
		 * had not read yet.
		 */
		const clearFailure = source => {
			if (bannerSource === source) hideBanner();
		};

		// A first load that fails is different in kind: there is no client
		// behind the message and nothing to do but read it, so it takes the
		// whole screen and takes it at once. Silencing this would be worse
		// than any amount of noise.
		const renderBootFailure = detail => {
			startup.style.color = '#b42318';
			const box = document.createElement('div');
			box.style.cssText = 'display:flex;flex-direction:column;gap:12px;max-width:34em;text-align:left';
			const sentence = document.createElement('div');
			sentence.textContent = SENTENCE_BOOT;
			sentence.style.cssText = 'font-size:17px;font-weight:600';
			const detailBox = document.createElement('pre');
			detailBox.hidden = true;
			detailBox.textContent = detail;
			detailBox.style.cssText = 'margin:0;max-height:45vh;overflow:auto;white-space:pre-wrap;word-break:break-all;'
				+ 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace';
			const toggle = makeButton(LABEL_DETAIL);
			toggle.addEventListener('click', () => {
				detailBox.hidden = !detailBox.hidden;
				toggle.textContent = detailBox.hidden ? LABEL_DETAIL : LABEL_COLLAPSE;
			});
			const logButton = makeButton(LABEL_LOG);
			logButton.addEventListener('click', () => openLog());
			const row = document.createElement('div');
			row.style.cssText = 'display:flex;gap:8px';
			row.append(toggle, logButton);
			box.append(sentence, row, detailBox);
			startup.replaceChildren(box);
			if (!startup.isConnected) document.body.replaceChildren(startup);
		};

		// The workbench opens the bridge itself and reports a failed connection
		// to the console, which a phone has no way to open: the shell renders in
		// full and then everything that needs data fails with nothing on screen
		// saying why. Watching the socket it opens is what lets one screenshot
		// carry the URL, how far the socket got, and the close code.
		//
		// A phone drops this socket for a living — the screen locks and the tab
		// is frozen, the network hands over from wifi to cellular, the tunnel
		// relay times a quiet socket out. The client reconnects on its own and
		// resumes the same session, so a drop that comes back is the connection
		// working, not a failure worth a screenful of red. Reporting every close
		// meant the banner covered the panel each time the user picked the phone
		// back up. Wait out the reconnect instead, and report only the silence
		// that outlasts it.
		//
		// The wait is keyed on whether the bridge has ever been open, not on
		// this socket: after a drop it is the *reconnect attempts* that fail to
		// open, and giving those no grace would report the very drop we are
		// waiting on. A first socket that never opens is a different thing — the
		// page is dead until someone acts — so that one is still reported at
		// once, with the refusal detail the server now sends.
		let booted = false;
		const RECONNECT_GRACE_MS = 8000;
		let bridgeEverOpened = false;
		let pendingReport;
		const NativeWebSocket = WebSocket;
		const watchBridge = (socket, url) => {
			let opened = false;
			socket.addEventListener('open', () => {
				opened = true;
				bridgeEverOpened = true;
				clearTimeout(pendingReport);
				pendingReport = undefined;
				logLine('bridge', 'open: ' + url);
				clearFailure('bridge');
			});
			socket.addEventListener('close', e => {
				const detail = url + '\\n'
					+ (opened ? 'the bridge was open and then closed' : 'the bridge never opened')
					+ ': code=' + e.code + (e.reason ? ', reason=' + e.reason : ', no reason given')
					+ ', readyState=' + socket.readyState;
				if (!bridgeEverOpened) {
					showFailure(SENTENCE_BRIDGE, detail, 'bridge');
					return;
				}
				// A drop the client is about to recover from is the connection
				// working, so it stays off the screen — and goes in the log,
				// which is the only place a recovered outage is countable
				// afterwards.
				logLine('bridge', 'closed, waiting out the reconnect: ' + detail);
				// One countdown for the whole outage: a later attempt closing
				// must not push the report further away, or a client retrying
				// steadily would never report at all.
				if (pendingReport !== undefined) return;
				pendingReport = setTimeout(() => {
					pendingReport = undefined;
					showFailure(SENTENCE_BRIDGE, detail, 'bridge');
				}, RECONNECT_GRACE_MS);
			});
		};
		window.WebSocket = function (url, protocols) {
			const socket = protocols === undefined
				? new NativeWebSocket(url)
				: new NativeWebSocket(url, protocols);
			if (String(url).startsWith(agentHostAddress)) watchBridge(socket, String(url));
			return socket;
		};
		window.WebSocket.prototype = NativeWebSocket.prototype;
		for (const state of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
			window.WebSocket[state] = NativeWebSocket[state];
		}

		// An Event told us something broke but not what. Ask the bridge directly:
		// its close code and reason are the actionable half, and the server now
		// answers a refused upgrade with an HTTP status instead of vanishing.
		// Deliberately the untouched constructor: this socket is the report, not
		// the client's own bridge, and watching it would report on itself.
		const probeBridge = () => new Promise(resolve => {
			let socket;
			try {
				socket = new NativeWebSocket(agentHostAddress);
			} catch (e) {
				resolve('could not even open a socket to ' + agentHostAddress + ': ' + describe(e));
				return;
			}
			let settled = false;
			const finish = text => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { socket.close(); } catch (e) { /* already gone */ }
				resolve(text);
			};
			const timer = setTimeout(() => finish('no answer from ' + agentHostAddress + ' within 5s'), 5000);
			socket.addEventListener('open', () => finish('the bridge at ' + agentHostAddress + ' accepted a fresh socket, so the failure is past the connection'));
			socket.addEventListener('close', e => finish('the bridge at ' + agentHostAddress + ' closed the connection: code=' + e.code + (e.reason ? ', reason=' + e.reason : ', no reason given')));
		});

		// How the workbench says "never mind": switching session before a model
		// resolves cancels every request in flight, and each one reaches this
		// page as an unhandled rejection indistinguishable from a real fault.
		// Mirrors isCancellationError, which this file cannot import.
		const isCancellation = value =>
			!!value && value.name === 'Canceled' && value.message === 'Canceled';

		// The rule, in one function. Anything that recovers on its own goes to
		// the log and no further. Anything else is a real failure and gets its
		// sentence — every time, because a failure the user is never told about
		// is worse than a small line saying so.
		const showError = error => {
			const detail = describe(error);
			if (isCancellation(error)) {
				// Nothing broke, so nothing is shown; one session produced
				// ~2600 of these, which is itself a fact about the client, so
				// they are still counted here rather than thrown away.
				logLine('cancelled', detail);
				return;
			}
			if (!booted) {
				logLine('boot-failed', detail);
				renderBootFailure(detail);
				return;
			}
			const seq = showFailure(SENTENCE_CLIENT, detail, 'client');
			// An Event says something broke but not what. Ask the bridge
			// directly and fold its answer into the same report.
			if (typeof Event !== 'undefined' && error instanceof Event && !error.message) {
				probeBridge().then(extra => amendFailure(seq, extra));
			}
		};
		window.addEventListener('error', e => showError(e.error || e.message || e));
		window.addEventListener('unhandledrejection', e => showError(e.reason));

		// The workbench measures the viewport the moment it is created and throws
		// when it reads zero. A browser that has not laid the page out yet — an
		// embedded web view, a tab restored in the background — reports zero
		// until its first frame, so wait for a real viewport before starting.
		//
		// Poll on a timer rather than on requestAnimationFrame. A hidden tab
		// never paints, so its animation frames never run: a rAF-only retry
		// deadlocks on exactly the background tab this wait exists to handle,
		// and the page sits on the startup text above forever instead of
		// booting when the tab is finally shown. Timers still fire in a hidden
		// tab, merely throttled.
		const waitForViewport = () => new Promise(resolve => {
			const check = () => {
				if (window.innerWidth > 0 && window.innerHeight > 0) {
					clearInterval(timer);
					resolve();
				}
			};
			const timer = setInterval(check, 200);
			check();
		});

		// Who this browser is, kept across reloads. The workbench mints a fresh
		// client id per connection, so every page load reached the host as a
		// brand-new client: the host keys its reconnect and replay off that id,
		// and a reload therefore could not resume the way an in-page reconnect
		// can. Reading the id here, once, is what makes a reload continuous.
		//
		// It lives in the browser rather than in workbench storage because the
		// service that consumes it is registered in every Agents window on the
		// desktop as well. An APPLICATION-scoped stored value would be one id
		// shared by several desktop windows, and the host would hold them as a
		// single client with several transports — most recent wins. Sourcing it
		// from the page confines the whole change to the phone: a desktop entry
		// carries no id, gets undefined, and keeps today's per-connection uuid.
		//
		// It is an identity, not a credential. Anyone who can load this page can
		// put any string in this key, so nothing may be granted, trusted or made
		// visible on the strength of it. What actually lets a request in is the
		// capability in the address and the session cookie; never keep either
		// under this key, and never derive one of them from the other.
		//
		// Two tabs on one phone share this storage and so present one id. That
		// is a shape the host already supports — overlapping transports on one
		// client record — not a collision.
		const CLIENT_ID_KEY = 'fumie.mobile.clientId';
		const readClientId = () => {
			// Private browsing and blocked site data make even touching
			// localStorage throw, so every access is guarded. No stable id is a
			// worse phone, not a broken one: the page still boots, and a fresh
			// id per load is exactly what the workbench would have minted.
			let stored;
			try {
				stored = localStorage.getItem(CLIENT_ID_KEY);
			} catch (e) {
				logLine('client-id', 'storage cannot be read, this load is a one-off client: ' + describe(e));
			}
			if (stored) {
				return stored;
			}
			// randomUUID needs a secure context. The tunnel is https and
			// loopback counts as secure, so this is the normal path — but a
			// plain-http origin would leave it undefined, and a page that
			// throws here shows nothing at all.
			const minted = typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: 'fumie-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
			try {
				localStorage.setItem(CLIENT_ID_KEY, minted);
			} catch (e) {
				logLine('client-id', 'storage cannot be written, this load is a one-off client: ' + describe(e));
			}
			return minted;
		};
		const clientId = readClientId();

		try {
			const { create } = await import('${options.modulePath}');
			await waitForViewport();

			startup.remove();
			create(document.body, {
				configurationDefaults: {
					'chat.remoteAgentHostsEnabled': true,
					'chat.remoteAgentHosts': [{
						address: agentHostAddress,
						name: 'This Mac',
						clientId,
					}],
					...${extraConfigurationDefaults},
				},
				productConfiguration: {
					nameShort: '${options.nameShort}',
					nameLong: '${options.nameLong}',
					enableTelemetry: false,
					sessionsRequireDefaultAccount: false,
					sessionsAccountUI: false,
					sessionsMinimalShell: true,
					sessionsAllowedAgentHostProviders: ['codex', 'claude', 'mock'],
				},
				workspaceProvider: {
					workspace: undefined,
					open: async () => false,
					payload: [['isSessionsWindow', 'true']],
				},
			});
			booted = true;
		} catch (error) {
			showError(error);
		}
	</script>
</body>
</html>`;
}
