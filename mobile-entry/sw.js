// Fumie 手机版入口的 Service Worker。
// 唯一职责:把 workbench 对 Dev Tunnels 管理 API 的跨域 HTTP 请求透明改道到
// 同源 /api/tunnels/* 代理(管理 API 的 CORS 只放行 vscode.dev)。
// 中继 WebSocket 不经过 fetch 事件,浏览器直连,不受影响。

const TUNNEL_API_RE = /^https:\/\/([a-z0-9-]+)\.rel\.tunnels\.api\.visualstudio\.com\//;

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', event => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
	const { request } = event;
	if (request.method !== 'GET' && request.method !== 'DELETE') {
		return;
	}
	const match = TUNNEL_API_RE.exec(request.url);
	if (!match) {
		return;
	}
	const original = new URL(request.url);
	const cluster = match[1]; // 主机名第一段,如 global / usw3 / usw3-data
	const target = new URL(`/api/tunnels/${cluster}${original.pathname}${original.search}`, self.location.origin);
	event.respondWith(fetch(target, {
		method: request.method,
		headers: request.headers,
	}));
});
