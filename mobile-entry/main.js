// Fumie 手机版固定入口。
// 状态机:GitHub 登录 → 隧道发现(引导/轮询)→ boot Sessions workbench。
// 发现与连接逻辑全部在上游 workbench(BrowserTunnelAgentHostService),
// 本文件只负责登录、隧道存在性检查与启动。

const TOKEN_KEY = 'fumie.githubToken';
const USER_KEY = 'fumie.githubUser';
// 隧道服务用 read:org 做访问控制,缺它管理 API 一律 401
// (见 cli/src/auth.rs get_default_scopes:'read:user+read:org')。
const SCOPES = ['read:user', 'read:org'];
const TUNNEL_LABEL = 'vscode-server-launcher';
const POLL_INTERVAL = 15_000;

const entryRoot = document.getElementById('entry-root');
let pollTimer;
let booted = false;

// ---------------------------------------------------------------- 渲染

function h(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === 'style') {
			node.style.cssText = value;
		} else {
			node[key] = value;
		}
	}
	for (const child of children) {
		node.append(child);
	}
	return node;
}

function renderScreen(children) {
	clearTimeout(pollTimer);
	entryRoot.replaceChildren(
		h('div', { className: 'entry-screen' }, [
			h('div', { className: 'entry-card' }, children),
		])
	);
	if (!entryRoot.isConnected) {
		document.body.replaceChildren(entryRoot);
	}
}

function showStatus(message) {
	renderScreen([
		h('h1', { textContent: 'Fumie' }),
		h('p', { textContent: message }),
	]);
}

function showError(error) {
	if (booted) {
		// workbench 启动后自身会处理/产生各种可恢复的 rejection(如取消),
		// 不再用错误屏覆盖界面。
		console.error('[fumie-entry]', error);
		return;
	}
	renderScreen([
		h('h1', { textContent: 'Fumie 手机端启动失败' }),
		h('p', { className: 'entry-error', textContent: error?.stack || error?.message || String(error) }),
		h('button', { className: 'entry-button', textContent: '重新加载', onclick: () => location.reload() }),
	]);
}

window.addEventListener('error', e => showError(e.error || e.message));
window.addEventListener('unhandledrejection', e => showError(e.reason));

// ---------------------------------------------------------------- Service Worker

async function ensureServiceWorker() {
	if (!('serviceWorker' in navigator)) {
		throw new Error('此浏览器不支持 Service Worker,无法连接隧道服务。');
	}
	await navigator.serviceWorker.register('./sw.js');
	await navigator.serviceWorker.ready;
	if (navigator.serviceWorker.controller) {
		return;
	}
	// 首次安装:sw.js 在 activate 时 clients.claim(),等它接管本页。
	await new Promise(resolve => {
		navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
	});
}

const swPromise = ensureServiceWorker();
swPromise.catch(() => { /* 错误在 boot() 时再抛出 */ });

// ---------------------------------------------------------------- 登录

function showLogin(notice) {
	renderScreen([
		h('h1', { textContent: 'Fumie' }),
		h('p', { textContent: notice || '登录 GitHub,连接你电脑上的 Fumie。' }),
		h('button', { className: 'entry-button', textContent: '使用 GitHub 登录', onclick: () => startLogin().catch(showError) }),
	]);
}

// 设备码登录:借 VS Code 官方应用身份(与桌面隧道 CLI 同款)。隧道服务只认
// 微软系应用签发的 GitHub token,自建 OAuth App 一律 401,详见 api/github-token.js。
async function startLogin() {
	showStatus('正在获取登录代码…');
	const res = await fetch('/api/github-token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action: 'device-start' }),
	});
	const start = await res.json().catch(() => ({}));
	if (!res.ok || !start.deviceCode) {
		throw new Error(`获取登录代码失败:${start.error || `HTTP ${res.status}`}`);
	}
	renderScreen([
		h('h1', { textContent: 'GitHub 登录' }),
		h('p', { textContent: '在 GitHub 授权页输入这个代码(应用名显示为 Visual Studio Code):' }),
		h('p', { style: 'font-size:32px;font-weight:700;letter-spacing:4px;margin:0 0 24px', textContent: start.userCode }),
		h('div', { style: 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap' }, [
			h('button', {
				className: 'entry-button', textContent: '复制代码并打开授权页', onclick: () => {
					navigator.clipboard?.writeText(start.userCode).catch(() => { /* 手动输入亦可 */ });
					window.open(start.verificationUri, '_blank');
				}
			}),
		]),
		h('p', { textContent: '授权完成后回到本页,会自动继续。' }),
	]);
	const token = await pollDeviceToken(start.deviceCode, start.interval ?? 5, start.expiresIn ?? 900);
	if (!token) {
		showLogin('登录超时,请重新开始。');
		return;
	}
	localStorage.setItem(TOKEN_KEY, token);
	await checkTunnels();
}

async function pollDeviceToken(deviceCode, intervalSeconds, expiresInSeconds) {
	const deadline = Date.now() + expiresInSeconds * 1000;
	let delay = intervalSeconds * 1000;
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, delay));
		const res = await fetch('/api/github-token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'device-poll', deviceCode }),
		});
		const data = await res.json().catch(() => ({}));
		if (data.accessToken) {
			if (data.diag) {
				sessionStorage.setItem('fumie.loginDiag', JSON.stringify(data.diag));
			}
			return data.accessToken;
		}
		if (data.pending) {
			continue;
		}
		if (data.slowDown) {
			delay += 5000;
			continue;
		}
		if (data.error) {
			throw new Error(`GitHub 登录失败:${data.error}`);
		}
	}
	return undefined;
}

function clearCredentials() {
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(USER_KEY);
}

function logout() {
	clearTimeout(pollTimer);
	clearCredentials();
	showLogin();
}

// ---------------------------------------------------------------- 隧道发现

function showGuide() {
	renderScreen([
		h('h1', { textContent: '桌面还没上线' }),
		h('p', { textContent: '还没有发现你电脑上的 Fumie。' }),
		h('ol', { className: 'entry-steps' }, [
			h('li', { textContent: '在电脑上打开 Fumie' }),
			h('li', { textContent: '打开 Allow Remote Connections 开关' }),
		]),
		h('div', { style: 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap' }, [
			h('button', { className: 'entry-button', textContent: '重新检查', onclick: () => checkTunnels().catch(showError) }),
			h('button', { className: 'entry-button secondary', textContent: '退出登录', onclick: logout }),
		]),
	]);
	pollTimer = setTimeout(() => checkTunnels().catch(showError), POLL_INTERVAL);
}

async function checkTunnels() {
	clearTimeout(pollTimer);
	const token = localStorage.getItem(TOKEN_KEY);
	if (!token) {
		showLogin();
		return;
	}
	showStatus('正在查找你的 Fumie 桌面…');
	// global=true 让 global 端点聚合所有集群(如东京 jpe1),与上游 SDK 的
	// 查询一致;缺了它只返回本区集群,别的集群的桌面隧道会被漏掉。
	const res = await fetch(
		`/api/tunnels/global/tunnels?api-version=2023-09-27-preview&labels=${TUNNEL_LABEL}&allLabels=true&global=true`,
		{ headers: { Authorization: `github ${token}` } }
	);
	if (res.status === 401 || res.status === 403) {
		// 刚换出的 token 也可能被隧道服务拒(如 App 类型不对),把上游给的
		// 原因带出来,避免误导成「过期」。
		const detail = (await res.text().catch(() => '')).slice(0, 200);
		const prefix = token.slice(0, 4);
		const diag = sessionStorage.getItem('fumie.loginDiag') ?? '';
		clearCredentials();
		showLogin(`登录未被隧道服务接受(HTTP ${res.status},token 前缀 ${prefix}…)。${detail ? `\n详情:${detail}` : ''}${diag ? `\n登录诊断:${diag}` : ''}\n请重新登录;若反复出现,检查 GitHub App 类型。`);
		return;
	}
	if (!res.ok) {
		throw new Error(`隧道查询失败(HTTP ${res.status})`);
	}
	const data = await res.json();
	const tunnels = (data?.value ?? []).flatMap(cluster => cluster?.value ?? []);
	if (tunnels.length === 0) {
		showGuide();
		return;
	}
	// 有隧道(在线或离线)即进 workbench,离线渲染与自动重连交给上游。
	await boot();
}

// ---------------------------------------------------------------- 认证 provider

async function fetchUser(token) {
	const cached = localStorage.getItem(USER_KEY);
	if (cached) {
		try {
			return JSON.parse(cached);
		} catch {
			// 缓存损坏,重取
		}
	}
	const res = await fetch('https://api.github.com/user', {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		throw new Error(`获取 GitHub 用户信息失败(HTTP ${res.status})`);
	}
	const user = await res.json();
	const slim = { id: String(user.id), login: user.login };
	localStorage.setItem(USER_KEY, JSON.stringify(slim));
	return slim;
}

function createGithubAuthProvider(Emitter) {
	const emitter = new Emitter();
	let cachedSession;

	const buildSession = async () => {
		const token = localStorage.getItem(TOKEN_KEY);
		if (!token) {
			return undefined;
		}
		if (cachedSession?.accessToken === token) {
			return cachedSession;
		}
		const user = await fetchUser(token);
		cachedSession = {
			id: 'fumie-github',
			accessToken: token,
			scopes: SCOPES,
			account: { id: user.id, label: user.login },
		};
		return cachedSession;
	};

	const scopesMatch = scopes =>
		scopes === undefined || Array.from(scopes).every(scope => SCOPES.includes(scope));

	return {
		id: 'github',
		label: 'GitHub',
		supportsMultipleAccounts: false,
		onDidChangeSessions: emitter.event,
		async getSessions(scopes) {
			if (!scopesMatch(scopes)) {
				return [];
			}
			const session = await buildSession();
			return session ? [session] : [];
		},
		async createSession() {
			const session = await buildSession();
			if (session) {
				return session;
			}
			// token 已失效:回到入口页重新走设备码登录。
			location.reload();
			return new Promise(() => { /* 页面即将重载 */ });
		},
		async removeSession() {
			const removed = cachedSession ? [cachedSession] : [];
			cachedSession = undefined;
			clearCredentials();
			emitter.fire({ added: [], removed, changed: [] });
		},
	};
}

// ---------------------------------------------------------------- boot

async function boot() {
	showStatus('正在启动 Fumie…');
	// 必须先让 Service Worker 接管页面,workbench 发出的第一个管理 API
	// 请求才会被改道到同源代理。
	await swPromise;
	const { create, Emitter } = await import('/bundle/vs/sessions/sessions.web.main.internal.js');
	// 预热用户信息缓存,失败(如 token 失效)在 boot 前暴露。
	await fetchUser(localStorage.getItem(TOKEN_KEY));
	const provider = createGithubAuthProvider(Emitter);
	entryRoot.replaceChildren();
	create(document.body, {
		authenticationProviders: [provider],
		productConfiguration: {
			nameShort: 'Fumie',
			nameLong: 'Fumie Mobile',
			enableTelemetry: false,
			sessionsRequireDefaultAccount: false,
			sessionsAccountUI: false,
			sessionsMinimalShell: true,
			sessionsAllowedAgentHostProviders: ['codex', 'claude', 'acp-claude', 'kimi', 'deepseek', 'pi'],
			tunnelApplicationConfig: {
				authenticationProviders: {
					github: { scopes: SCOPES },
				},
			},
		},
		configurationDefaults: {
			'chat.remoteAgentHostsEnabled': true,
		},
		workspaceProvider: {
			workspace: undefined,
			open: async () => false,
			payload: [['isSessionsWindow', 'true']],
		},
	});
	booted = true;
}

// ---------------------------------------------------------------- 入口

async function main() {
	const token = localStorage.getItem(TOKEN_KEY);
	if (!token) {
		showLogin();
		return;
	}
	await checkTunnels();
}

main().catch(showError);
