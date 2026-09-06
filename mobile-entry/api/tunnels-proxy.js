// Dev Tunnels 管理 API 的同源代理。
// 页面请求 /api/tunnels/<cluster>/<...rest>,vercel.json 把它 rewrite 到本函数
// 并把子路径放进 ?path=(Vercel 无框架项目不支持 api/ 目录的 [...slug] 路由)。
// cluster 是目标主机名第一段(global / usw3 / usw3-data 等),目标为
// https://<cluster>.rel.tunnels.api.visualstudio.com/<...rest>。

const CLUSTER_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export default async function handler(req, res) {
	if (req.method !== 'GET' && req.method !== 'DELETE') {
		res.status(405).json({ error: 'method not allowed' });
		return;
	}

	const raw = req.query.path;
	const segments = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
		.flatMap(part => part.split('/'))
		.filter(Boolean);
	const [cluster, ...rest] = segments;
	if (!cluster || !CLUSTER_RE.test(cluster)) {
		res.status(400).json({ error: 'invalid path' });
		return;
	}

	const target = new URL(`https://${cluster}.rel.tunnels.api.visualstudio.com/${rest.map(encodeURIComponent).join('/')}`);
	for (const [key, value] of Object.entries(req.query)) {
		if (key === 'path') {
			continue;
		}
		for (const v of Array.isArray(value) ? value : [value]) {
			target.searchParams.append(key, v);
		}
	}

	const headers = {};
	if (req.headers.authorization) {
		headers.authorization = req.headers.authorization;
	}
	if (req.headers.accept) {
		headers.accept = req.headers.accept;
	}

	const upstream = await fetch(target, { method: req.method, headers });
	res.status(upstream.status);
	const contentType = upstream.headers.get('content-type');
	if (contentType) {
		res.setHeader('content-type', contentType);
	}
	res.send(Buffer.from(await upstream.arrayBuffer()));
}
