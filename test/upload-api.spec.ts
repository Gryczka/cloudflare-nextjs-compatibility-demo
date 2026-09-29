import { describe, expect, it } from 'vitest';
import {
	limitUploadStream,
	MAX_UPLOAD_BYTES,
	resolveUploadApiConfig,
	rollbackUploadSource,
	siteHostnameForUuid,
	siteSlugForUuid,
	UploadApiError,
	uploadRunR2Prefix,
	uploadSourceR2Key,
	validateSiteHostnameSuffix,
	validateUploadRunRequest,
	type UploadCleanupBucket,
} from '../src/upload-api';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const HOSTNAME_SUFFIX = 'preview.example.com';

describe('upload request metadata', () => {
	it('accepts raw ZIP bodies with optional or required lengths at the inclusive boundary', () => {
		const chunked = uploadRequest();
		const fixed = uploadRequest({ 'Content-Length': String(MAX_UPLOAD_BYTES) });

		expect(validateUploadRunRequest(chunked)).toMatchObject({ contentLength: null, body: chunked.body });
		expect(validateUploadRunRequest(fixed, { contentLengthPolicy: 'required' })).toMatchObject({
			contentLength: MAX_UPLOAD_BYTES,
			body: fixed.body,
		});
	});

	it.each(['', 'multipart/form-data; boundary=upload', 'application/octet-stream', 'text/plain'])(
		'rejects unsupported media type %s',
		(contentType) => {
			const error = captureApiError(() => validateUploadRunRequest(uploadRequest({ 'Content-Type': contentType })));
			expect(error).toMatchObject({ code: 'UNSUPPORTED_UPLOAD_MEDIA_TYPE', status: 415 });
		},
	);

	it('rejects cross-origin and cross-site mutations', () => {
		const crossOrigin = captureApiError(() => validateUploadRunRequest(uploadRequest({ Origin: 'https://attacker.example' })));
		const crossSite = captureApiError(() => validateUploadRunRequest(uploadRequest({ 'Sec-Fetch-Site': 'cross-site' })));

		expect(crossOrigin).toMatchObject({ code: 'CROSS_ORIGIN_UPLOAD', status: 403 });
		expect(crossSite).toMatchObject({ code: 'CROSS_ORIGIN_UPLOAD', status: 403 });
	});

	it('allows explicit same-origin browser metadata', () => {
		const request = uploadRequest({ Origin: 'https://control.example', 'Sec-Fetch-Site': 'same-origin' });
		expect(validateUploadRunRequest(request).contentLength).toBeNull();
	});

	it('distinguishes missing, malformed, empty, and oversized lengths', () => {
		const missing = captureApiError(() => validateUploadRunRequest(uploadRequest(), { contentLengthPolicy: 'required' }));
		expect(missing).toMatchObject({ code: 'CONTENT_LENGTH_REQUIRED', status: 411 });

		for (const value of ['0', '-1', '1.5', '1, 1', '9007199254740992']) {
			const error = captureApiError(() => validateUploadRunRequest(uploadRequest({ 'Content-Length': value })));
			expect(error).toMatchObject({ code: 'INVALID_CONTENT_LENGTH', status: 400 });
		}

		const oversized = captureApiError(() => validateUploadRunRequest(uploadRequest({ 'Content-Length': String(MAX_UPLOAD_BYTES + 1) })));
		expect(oversized).toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
	});

	it('requires the endpoint method, path, and a readable body', () => {
		const wrongMethod = captureApiError(() =>
			validateUploadRunRequest(
				new Request('https://control.example/api/upload-runs', {
					method: 'GET',
					headers: { 'Content-Type': 'application/zip' },
				}),
			),
		);
		const wrongPath = captureApiError(() =>
			validateUploadRunRequest(
				new Request('https://control.example/api/other', {
					method: 'POST',
					headers: { 'Content-Type': 'application/zip' },
					body: new Uint8Array([1]),
				}),
			),
		);
		const missingBody = captureApiError(() =>
			validateUploadRunRequest(
				new Request('https://control.example/api/upload-runs', {
					method: 'POST',
					headers: { 'Content-Type': 'application/zip' },
				}),
			),
		);

		expect(wrongMethod).toMatchObject({ code: 'INVALID_UPLOAD_REQUEST', status: 405 });
		expect(wrongPath).toMatchObject({ code: 'INVALID_UPLOAD_REQUEST', status: 404 });
		expect(missingBody).toMatchObject({ code: 'UPLOAD_BODY_REQUIRED', status: 400 });
	});
});

describe('upload stream limiting', () => {
	it('errors before forwarding the chunk that crosses the limit', async () => {
		let cancellationReason: unknown;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3, 4]));
				controller.enqueue(new Uint8Array([5, 6]));
			},
			cancel(reason) {
				cancellationReason = reason;
			},
		});
		const reader = limitUploadStream(source, 5).getReader();

		expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 2, 3, 4]) });
		await expect(reader.read()).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
		expect(cancellationReason).toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
	});

	it('streams the exact 50 MiB boundary without retaining chunks', async () => {
		expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
		expect(await consumeByteLength(limitUploadStream(byteStream(MAX_UPLOAD_BYTES)))).toBe(MAX_UPLOAD_BYTES);
	});

	it('passes consumer cancellation and its reason to the source', async () => {
		const reason = new Error('consumer stopped');
		let cancellationReason: unknown;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel(value) {
				cancellationReason = value;
			},
		});
		const reader = limitUploadStream(source).getReader();

		expect((await reader.read()).value).toEqual(new Uint8Array([1]));
		await reader.cancel(reason);
		expect(cancellationReason).toBe(reason);
	});

	it('propagates source read and cancellation failures', async () => {
		const readError = new Error('source read failed');
		const failedSource = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(readError);
			},
		});
		const failedReader = limitUploadStream(failedSource).getReader();
		await expect(failedReader.read()).rejects.toBe(readError);

		const cancelError = new Error('source cancellation failed');
		const uncancellableSource = new ReadableStream<Uint8Array>({
			cancel() {
				throw cancelError;
			},
		});
		await expect(limitUploadStream(uncancellableSource).cancel('stop')).rejects.toBe(cancelError);
	});
});

describe('upload configuration and deterministic identities', () => {
	it('fails closed while disabled and validates enabled configuration', () => {
		expect(
			resolveUploadApiConfig({
				enabled: 'false',
				hostnameSuffix: 'INVALID',
				maxBytes: MAX_UPLOAD_BYTES + 1,
			}),
		).toEqual({ enabled: false });
		expect(
			resolveUploadApiConfig({
				enabled: 'true',
				hostnameSuffix: HOSTNAME_SUFFIX,
				contentLengthPolicy: 'required',
				maxBytes: '1024',
			}),
		).toEqual({
			enabled: true,
			hostnameSuffix: HOSTNAME_SUFFIX,
			contentLengthPolicy: 'required',
			maxBytes: 1024,
		});
	});

	it.each([
		{},
		{ enabled: true, hostnameSuffix: HOSTNAME_SUFFIX },
		{ enabled: 'yes', hostnameSuffix: HOSTNAME_SUFFIX },
		{ enabled: 'true' },
		{ enabled: 'true', hostnameSuffix: 'UPPER.example.com' },
		{ enabled: 'true', hostnameSuffix: HOSTNAME_SUFFIX, contentLengthPolicy: 'sometimes' },
		{ enabled: 'true', hostnameSuffix: HOSTNAME_SUFFIX, maxBytes: 0 },
		{ enabled: 'true', hostnameSuffix: HOSTNAME_SUFFIX, maxBytes: MAX_UPLOAD_BYTES + 1 },
	])('rejects invalid enabled configuration %#', (config) => {
		const error = captureApiError(() => resolveUploadApiConfig(config));
		expect(error).toMatchObject({ code: 'INVALID_UPLOAD_CONFIG', status: 503 });
	});

	it('isolates deterministic R2 keys by canonical UUID', () => {
		expect(uploadRunR2Prefix(RUN_ID.toUpperCase())).toBe(`runs/${RUN_ID}/`);
		expect(uploadSourceR2Key(RUN_ID)).toBe(`runs/${RUN_ID}/source/upload.zip`);
		expect(uploadSourceR2Key(OTHER_RUN_ID)).toBe(`runs/${OTHER_RUN_ID}/source/upload.zip`);
		expect(uploadSourceR2Key(OTHER_RUN_ID).startsWith(uploadRunR2Prefix(RUN_ID))).toBe(false);
		expect(() => uploadSourceR2Key(`${RUN_ID}/../${OTHER_RUN_ID}`)).toThrow('runId must be a UUID');
	});

	it('generates a stable DNS label and validates the complete hostname', () => {
		const slug = `site-${RUN_ID}`;
		expect(siteSlugForUuid(RUN_ID.toUpperCase())).toBe(slug);
		expect(validateSiteHostnameSuffix(HOSTNAME_SUFFIX)).toBe(HOSTNAME_SUFFIX);
		expect(siteHostnameForUuid(RUN_ID, HOSTNAME_SUFFIX)).toBe(`${slug}.${HOSTNAME_SUFFIX}`);
		expect(siteHostnameForUuid(OTHER_RUN_ID, HOSTNAME_SUFFIX)).not.toBe(`${slug}.${HOSTNAME_SUFFIX}`);
	});

	it.each(['UPPER.example.com', '*.example.com', '.example.com', 'example.com.', 'https://example.com', `${'a'.repeat(64)}.example.com`])(
		'rejects invalid hostname suffix %j',
		(suffix) => {
			expect(() => siteHostnameForUuid(RUN_ID, suffix)).toThrow('hostname');
		},
	);

	it('rejects a valid suffix when the generated hostname would exceed 253 characters', () => {
		const longSuffix = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}`;
		expect(validateSiteHostnameSuffix(longSuffix)).toBe(longSuffix);
		expect(() => siteHostnameForUuid(RUN_ID, longSuffix)).toThrow('253');
	});
});

describe('failed upload cleanup', () => {
	it('idempotently removes only the failed run source key', async () => {
		const bucket = new FakeBucket([uploadSourceR2Key(RUN_ID), uploadSourceR2Key(OTHER_RUN_ID)]);

		await rollbackUploadSource(bucket, RUN_ID);
		await rollbackUploadSource(bucket, RUN_ID);

		expect(bucket.keys).toEqual(new Set([uploadSourceR2Key(OTHER_RUN_ID)]));
		expect(bucket.deleted).toEqual([uploadSourceR2Key(RUN_ID), uploadSourceR2Key(RUN_ID)]);
	});
});

function uploadRequest(headers: HeadersInit = {}): Request {
	const requestHeaders = new Headers(headers);
	if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/zip');
	return new Request('https://control.example/api/upload-runs', {
		method: 'POST',
		headers: requestHeaders,
		body: new Uint8Array([1]),
	});
}

function captureApiError(operation: () => unknown): UploadApiError {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(UploadApiError);
		return error as UploadApiError;
	}
	throw new Error('Expected UploadApiError');
}

function byteStream(totalBytes: number): ReadableStream<Uint8Array> {
	let remaining = totalBytes;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (remaining === 0) {
				controller.close();
				return;
			}
			const length = Math.min(remaining, 1024 * 1024);
			remaining -= length;
			controller.enqueue(new Uint8Array(length));
		},
	});
}

async function consumeByteLength(stream: ReadableStream<Uint8Array>): Promise<number> {
	let length = 0;
	for await (const chunk of stream) length += chunk.byteLength;
	return length;
}

class FakeBucket implements UploadCleanupBucket {
	readonly keys: Set<string>;
	readonly deleted: string[] = [];

	constructor(keys: readonly string[]) {
		this.keys = new Set(keys);
	}

	async delete(keys: string | string[]): Promise<void> {
		for (const key of typeof keys === 'string' ? [keys] : keys) {
			this.deleted.push(key);
			this.keys.delete(key);
		}
	}
}
