#!/usr/bin/env node
/** Publish the fixed Workers for Platforms template with either a private demo
 * visitor session or a Cloudflare Access token. No account API token is read here.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sessionDirectory = join(homedir(), '.config', 'nextjs-compatibility-demo');
const sessionFile = join(sessionDirectory, 'session.json');
const [command = 'publish', argument = 'examples/emdash-wfp/environment.example.json'] = process.argv.slice(2);

try {
	const configuredUrl = process.env.COMPATIBILITY_CONTROL_PLANE_URL;
	if (!configuredUrl) throw new Error('Set COMPATIBILITY_CONTROL_PLANE_URL to your deployed Worker URL.');
	const baseUrl = new URL(configuredUrl);
	if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
		throw new Error('The control-plane URL must use HTTPS outside localhost.');
	}
	const mode = process.env.COMPATIBILITY_AUTH ?? 'demo';
	if (mode !== 'demo' && mode !== 'access') throw new Error('COMPATIBILITY_AUTH must be demo or access.');
	const identity = mode === 'demo' ? await visitorSession(baseUrl.origin) : { token: await accessToken(baseUrl.origin) };
	const result =
		command === 'publish'
			? await publish(baseUrl, argument, identity)
			: command === 'delete'
				? await remove(baseUrl, argument, identity)
				: command === 'list'
					? await list(baseUrl, identity)
					: null;
	if (!result) {
		throw new Error(
			'Usage: npm run emdash:publish -- [manifest.json], npm run emdash:delete -- <environment-slug>, or npm run emdash:list',
		);
	}
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

async function publish(baseUrl, manifestPath, identity) {
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	return request(baseUrl, '/api/wfp/environments', identity, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: baseUrl.origin },
		body: JSON.stringify(manifest),
	});
}

async function remove(baseUrl, slug, identity) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Environment slug is invalid');
	return request(baseUrl, `/api/wfp/environments/${encodeURIComponent(slug)}`, identity, {
		method: 'DELETE',
		headers: { Origin: baseUrl.origin },
	});
}

async function list(baseUrl, identity) {
	return request(baseUrl, '/api/wfp/environments', identity, { method: 'GET', headers: {} });
}

async function request(baseUrl, path, identity, init) {
	const response = await fetch(new URL(path, baseUrl), {
		...init,
		headers: { ...init.headers, ...(identity.cookie ? { Cookie: identity.cookie } : { 'cf-access-token': identity.token }) },
		signal: AbortSignal.timeout(30_000),
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const retryAfter = response.headers.get('Retry-After');
		throw new Error(
			`${body?.error ?? `Control plane returned HTTP ${response.status}`}${retryAfter ? ` Retry after ${retryAfter}s.` : ''}`,
		);
	}
	return body;
}

async function visitorSession(origin) {
	try {
		const cached = JSON.parse(await readFile(sessionFile, 'utf8'));
		if (
			cached.origin === origin &&
			/^__Host-compatibility-session=[a-f0-9]{64}$/.test(cached.cookie) &&
			cached.expiresAt > Date.now() + 10_000
		) {
			return { cookie: cached.cookie };
		}
	} catch (error) {
		if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
	}
	const response = await fetch(new URL('/api/session', origin), { signal: AbortSignal.timeout(30_000) });
	const body = await response.json().catch(() => null);
	if (!response.ok || body?.mode !== 'public-demo') {
		throw new Error(`${body?.error ?? 'Demo session unavailable'}. For an Access-protected installation, set COMPATIBILITY_AUTH=access.`);
	}
	const cookie = response.headers.get('Set-Cookie')?.split(';', 1)[0];
	if (!cookie || !/^__Host-compatibility-session=[a-f0-9]{64}$/.test(cookie)) {
		throw new Error('Demo did not return a secure visitor session.');
	}
	await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
	await chmod(sessionDirectory, 0o700);
	const temporaryFile = `${sessionFile}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryFile, JSON.stringify({ origin, cookie, expiresAt: Date.now() + 2 * 60 * 60_000 }), {
			mode: 0o600,
			flag: 'wx',
		});
		await rename(temporaryFile, sessionFile);
	} catch (error) {
		await rm(temporaryFile, { force: true });
		throw new Error(`Could not store the visitor session: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { cookie };
}

async function accessToken(appUrl) {
	if (process.env.COMPATIBILITY_ACCESS_TOKEN) return process.env.COMPATIBILITY_ACCESS_TOKEN;
	try {
		const { stdout } = await exec('cloudflared', ['access', 'token', '--app', appUrl], { timeout: 5 * 60_000 });
		const token = stdout.trim();
		if (!token) throw new Error('cloudflared returned an empty Access token');
		return token;
	} catch (error) {
		throw new Error(
			`Could not obtain a Cloudflare Access token. Install cloudflared and authenticate, or set COMPATIBILITY_ACCESS_TOKEN. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
