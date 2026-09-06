// GitHub 设备码登录代理(github.com 的 OAuth 端点没有 CORS,浏览器只能经此转发)。
// 使用与隧道 CLI 相同的 VS Code 官方 client id(cli/src/auth.rs)——Dev Tunnels
// 服务只接受微软系应用签发的 GitHub token,自建 OAuth App 的 token 会被 401
// (2026-09-01 实测:同账号同 scope,仅 client 不同,结果 401 vs 200)。
// 设备码流程不需要 client secret,因此本函数不依赖任何环境变量。

const CLIENT_ID = '01ab8ac9400c4e429b23';
const SCOPE = 'read:user read:org';

export default async function handler(req, res) {
	if (req.method !== 'POST') {
		res.status(405).json({ error: 'method not allowed' });
		return;
	}

	const action = req.body?.action;

	if (action === 'device-start') {
		const upstream = await fetch('https://github.com/login/device/code', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
		});
		const data = await upstream.json().catch(() => ({}));
		if (!upstream.ok || !data.device_code) {
			res.status(502).json({ error: data.error || 'device code request failed' });
			return;
		}
		res.status(200).json({
			deviceCode: data.device_code,
			userCode: data.user_code,
			verificationUri: data.verification_uri,
			interval: data.interval,
			expiresIn: data.expires_in,
		});
		return;
	}

	if (action === 'device-poll') {
		const deviceCode = req.body?.deviceCode;
		if (!deviceCode || typeof deviceCode !== 'string') {
			res.status(400).json({ error: 'missing deviceCode' });
			return;
		}
		const upstream = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			}),
		});
		const data = await upstream.json().catch(() => ({}));

		if (data.access_token) {
			// 诊断:立刻用新 token 试一次隧道管理 API,结果写进函数日志并回传,
			// 便于远程定位登录类问题。
			let diag;
			try {
				const ms = await fetch('https://global.rel.tunnels.api.visualstudio.com/tunnels?api-version=2023-09-27-preview&limit=1', {
					headers: { Authorization: `github ${data.access_token}`, Accept: 'application/json' },
				});
				diag = { githubScope: data.scope ?? '', tunnelStatus: ms.status };
			} catch (error) {
				diag = { githubScope: data.scope ?? '', tunnelError: String(error) };
			}
			console.log('[github-token] diag', JSON.stringify(diag));
			res.status(200).json({ accessToken: data.access_token, diag });
			return;
		}
		if (data.error === 'authorization_pending') {
			res.status(200).json({ pending: true });
			return;
		}
		if (data.error === 'slow_down') {
			res.status(200).json({ slowDown: true });
			return;
		}
		res.status(200).json({ error: data.error || 'device authorization failed' });
		return;
	}

	res.status(400).json({ error: 'unknown action' });
}
