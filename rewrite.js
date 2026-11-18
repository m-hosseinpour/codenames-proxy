#!/usr/bin/env node
// Serves codenames.game through your own domain so it stays playable where the game is blocked.
//
// Caddy puts the blocked origin behind a proxy (see caddy/site.caddyfile), but the game client opens
// its realtime connection to https://server-discord.gke.codenames.game — a host name baked into the
// bundle that the server also hands out as a ?serverURL= query parameter. That websocket bypasses
// Caddy, so "Enter Game" spins forever. This service therefore serves the HTML document with one
// extra inline script at the top of <head> that wraps window.WebSocket and rewrites that host to
// this domain:
//
//   new WebSocket("wss://server-discord.gke.codenames.game/3/socket.io/...")
//   -> new WebSocket("wss://your.domain/3/socket.io/...")
//
// Caddy answers those /<namespace>/socket.io/ paths with the real game server. Patching the
// constructor covers every caller, including chunks that are lazily imported from the CDN after the
// page loads — no response rewrite on this side can reach those.
//
// Only GET documents are routed here; assets, RSC payloads, POSTs and the websocket itself stay on
// Caddy's reverse_proxy path. Nothing else about the page is altered.
//
// Configuration (environment):
//   PUBLIC_BASE        required; the public URL this service is reachable on, e.g. https://game.example.com
//   LISTEN_HOST:PORT   optional; default 127.0.0.1:8090, meant for a local reverse proxy only
//   UPSTREAM_PROXY_URL optional; HTTP proxy used to reach the blocked site, default http://127.0.0.1:1080
//   DISABLE_FLAG       optional; while this file exists every page answers 503

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const tls = require('node:tls');
const zlib = require('node:zlib');

const SITE = 'codenames.game';
const SOCKET_HOST = 'server-discord.gke.codenames.game';

const PUBLIC_BASE = process.env.PUBLIC_BASE || '';
if (!PUBLIC_BASE) {
	console.error('PUBLIC_BASE is required, e.g. PUBLIC_BASE=https://game.example.com');
	process.exit(1);
}
const PUBLIC_HOST = new URL(PUBLIC_BASE).host;
const LISTEN = {
	host: process.env.LISTEN_HOST || '127.0.0.1',
	port: Number(process.env.LISTEN_PORT || 8090),
};
const UPSTREAM_PROXY = new URL(process.env.UPSTREAM_PROXY_URL || 'http://127.0.0.1:1080');
// Owner's kill switch: while this file exists every page request answers 503. Toggled by ./toggle.
const DISABLE_FLAG = process.env.DISABLE_FLAG || path.join(os.homedir(), '.config', 'codenames-proxy', 'disabled');
const TIMEOUT_MS = 20000;
const ATTEMPTS = 2;

const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'proxy-authenticate']);
const FORWARD_REQUEST_HEADERS = ['cookie', 'accept', 'accept-language', 'user-agent', 'referer', 'x-forwarded-for'];

// Installed before any application script runs, so every websocket the game opens goes through this
// domain. Kept dependency-free and quiet: it must not throw into the page.
const SHIM = `<script>(function(){var O=window.WebSocket;if(!O)return;function f(u){try{if(typeof u!=="string")u=String(u);if(u.indexOf("${SOCKET_HOST}")===-1)return u;var d=location.host;return u.replace("${SOCKET_HOST}",d);}catch(e){return u;}}function W(u,p){return p===undefined?new O(f(u)):new O(f(u),p);}W.prototype=O.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSING=2;W.CLOSED=3;window.WebSocket=W;})();</script>`;

const DISABLED_PAGE = `<!doctype html><meta charset="utf-8"><title>Disabled</title>
<body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem">
<h1 style="font-size:1.2rem">This site is disabled</h1>
<p>Turn it back on with <code>./toggle on</code> on the server.</p>
</body>`;

// The origin is blocked from this network, so it is reached through the configured HTTP proxy.
function openTunnel(host) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: UPSTREAM_PROXY.hostname,
			port: UPSTREAM_PROXY.port || 80,
			method: 'CONNECT',
			path: `${host}:443`,
			headers: { host: `${host}:443` },
			timeout: TIMEOUT_MS,
		});
		req.on('connect', (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`proxy CONNECT ${res.statusCode}`));
				return;
			}
			const secure = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] }, () => resolve(secure));
			secure.on('error', reject);
		});
		req.on('timeout', () => req.destroy(new Error('proxy timeout')));
		req.on('error', reject);
		req.end();
	});
}

// Plain HTTP/1.1 over the TLS socket the tunnel already established. Node ignores a createConnection
// given in the request options when `agent` is false, so it goes on an explicit agent: without that
// it dials the origin on port 80 in clear text and the site answers 308 to https.
function get(host, requestPath, headers, socket) {
	return new Promise((resolve, reject) => {
		const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
		agent.createConnection = () => socket;
		const request = http.request({
			method: 'GET',
			host,
			path: requestPath,
			headers: { ...headers, host },
			timeout: TIMEOUT_MS,
			agent,
			setHost: false,
		});
		request.on('response', (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		request.on('timeout', () => request.destroy(new Error('upstream timeout')));
		request.on('error', reject);
		request.end();
	});
}

// A reset proxy CONNECT and a stalled origin response were both seen while testing; one retry keeps a
// single bad socket from failing a whole page load.
async function withRetry(attempt) {
	for (let attemptNumber = 1; ; attemptNumber += 1) {
		try {
			return await attempt();
		} catch (error) {
			if (attemptNumber >= ATTEMPTS) throw error;
			console.warn(`upstream attempt ${attemptNumber} failed: ${error.message}`);
		}
	}
}

function decode(body, encoding) {
	switch (encoding) {
		case 'gzip':
		case 'x-gzip':
			return zlib.gunzipSync(body);
		case 'deflate':
			return zlib.inflateSync(body);
		case 'br':
			return zlib.brotliDecompressSync(body);
		default:
			return body;
	}
}

function rewriteDocument(text) {
	// The preconnect hints point at the blocked host; harmless but pointless if left alone.
	let out = text.replaceAll(SOCKET_HOST, PUBLIC_HOST);
	if (!out.includes('<head')) {
		console.warn('document had no <head>; the websocket shim was not injected');
		return out;
	}
	return out.replace(/<head([^>]*)>/i, `<head$1>${SHIM}`);
}

function forwardRequestHeaders(req) {
	const headers = { 'accept-encoding': 'identity' };
	for (const field of FORWARD_REQUEST_HEADERS) {
		if (req.headers[field]) headers[field] = req.headers[field];
	}
	// Caddy's reverse_proxy normally supplies these; without them the origin treats the request as
	// plain HTTP and answers 308 to https.
	headers['x-forwarded-proto'] = 'https';
	if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
	return headers;
}

function send(res, status, headers, body) {
	const out = { ...headers };
	for (const field of DROP_RESPONSE_HEADERS) delete out[field];
	out['content-length'] = String(body.length);
	res.writeHead(status, out);
	res.end(res.req.method === 'HEAD' ? undefined : body);
}

async function fetchDocument(req) {
	const socket = await openTunnel(SITE);
	try {
		return await get(SITE, req.url, forwardRequestHeaders(req), socket);
	} finally {
		socket.destroy();
	}
}

async function handleDocument(req, res) {
	const upstream = await withRetry(() => fetchDocument(req));
	const headers = { ...upstream.headers };

	if (upstream.status === 304 || upstream.body.length === 0) {
		send(res, upstream.status, headers, upstream.body);
		return;
	}

	let body = decode(upstream.body, upstream.headers['content-encoding']);
	if (/text\/html/i.test(upstream.headers['content-type'] || '')) {
		body = Buffer.from(rewriteDocument(body.toString('utf8')), 'utf8');
	}
	delete headers['content-encoding'];

	// Absolute redirects would send the browser straight back to the blocked origin.
	if (headers.location) headers.location = headers.location.replace(`https://${SITE}`, `https://${PUBLIC_HOST}`);

	send(res, upstream.status, headers, body);
}

const server = http.createServer(async (req, res) => {
	try {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, Buffer.from('method not allowed\n'));
			return;
		}
		if (!req.url.startsWith('/')) {
			send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('bad request target\n'));
			return;
		}
		if (fs.existsSync(DISABLE_FLAG)) {
			send(res, 503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, Buffer.from(DISABLED_PAGE));
			return;
		}
		await handleDocument(req, res);
	} catch (error) {
		console.error(`${new Date().toISOString()} ${req.method} ${req.url}: ${error.message}`);
		send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from(`codenames-rewrite: ${error.message}\n`));
	}
});

server.on('clientError', (_error, socket) => socket.destroy());
server.listen(LISTEN.port, LISTEN.host, () => {
	console.log(`codenames-rewrite listening on http://${LISTEN.host}:${LISTEN.port}, ${SOCKET_HOST} -> ${PUBLIC_HOST}`);
});
