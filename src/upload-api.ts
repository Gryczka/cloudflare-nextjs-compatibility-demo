/** Streaming validation helpers for uploads; the hosted Worker exposes no upload route. */
import { DEFAULT_SOURCE_ARCHIVE_LIMITS } from './source-archive';
import { validateHostname, validateSiteSlug } from './site-registry';

export const UPLOAD_RUN_PATH = '/api/upload-runs';
export const UPLOAD_ZIP_MEDIA_TYPE = 'application/zip';
export const MAX_UPLOAD_BYTES = DEFAULT_SOURCE_ARCHIVE_LIMITS.maxCompressedBytes;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIGURATION_PROBE_UUID = '00000000-0000-4000-8000-000000000000';

export type UploadApiErrorCode =
	| 'INVALID_UPLOAD_CONFIG'
	| 'INVALID_UPLOAD_REQUEST'
	| 'UNSUPPORTED_UPLOAD_MEDIA_TYPE'
	| 'CROSS_ORIGIN_UPLOAD'
	| 'CONTENT_LENGTH_REQUIRED'
	| 'INVALID_CONTENT_LENGTH'
	| 'UPLOAD_BODY_REQUIRED'
	| 'UPLOAD_TOO_LARGE'
	| 'INVALID_UPLOAD_STREAM';

export class UploadApiError extends Error {
	constructor(
		readonly code: UploadApiErrorCode,
		message: string,
		readonly status: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'UploadApiError';
	}
}

export type UploadContentLengthPolicy = 'optional' | 'required';

export interface UploadRequestValidationOptions {
	contentLengthPolicy?: UploadContentLengthPolicy;
	maxBytes?: number;
}

export interface ValidatedUploadRunRequest {
	body: ReadableStream<Uint8Array>;
	contentLength: number | null;
}

export interface EnabledUploadApiConfig {
	enabled: true;
	hostnameSuffix: string;
	contentLengthPolicy: UploadContentLengthPolicy;
	maxBytes: number;
}

export type UploadApiConfig = { enabled: false } | EnabledUploadApiConfig;

export interface UploadApiConfigInput {
	enabled: unknown;
	hostnameSuffix?: unknown;
	contentLengthPolicy?: unknown;
	maxBytes?: unknown;
}

export type UploadCleanupBucket = Pick<R2Bucket, 'delete'>;

export function resolveUploadApiConfig(input: unknown): UploadApiConfig {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw invalidConfig('Upload API configuration must be an object');
	}
	const value = input as Record<string, unknown>;
	if (value.enabled === 'false') return Object.freeze({ enabled: false });
	if (value.enabled !== 'true') {
		throw invalidConfig('Upload API enabled must be configured as true or false');
	}

	const contentLengthPolicy = validateContentLengthPolicy(value.contentLengthPolicy ?? 'optional');
	const maxBytes = validateMaxBytes(value.maxBytes ?? MAX_UPLOAD_BYTES);
	let hostnameSuffix: string;
	try {
		hostnameSuffix = validateSiteHostnameSuffix(value.hostnameSuffix);
		// Validate the complete generated hostname, not only the configured suffix.
		siteHostnameForUuid(CONFIGURATION_PROBE_UUID, hostnameSuffix);
	} catch (error) {
		throw invalidConfig('Upload API hostnameSuffix must produce a valid site hostname', error);
	}

	return Object.freeze({ enabled: true, hostnameSuffix, contentLengthPolicy, maxBytes });
}

export function validateUploadRunRequest(request: Request, options: UploadRequestValidationOptions = {}): ValidatedUploadRunRequest {
	const maxBytes = validateMaxBytes(options.maxBytes ?? MAX_UPLOAD_BYTES);
	const contentLengthPolicy = validateContentLengthPolicy(options.contentLengthPolicy ?? 'optional');
	const url = new URL(request.url);

	if (request.method !== 'POST') {
		throw new UploadApiError('INVALID_UPLOAD_REQUEST', 'Upload run creation requires POST', 405);
	}
	if (url.pathname !== UPLOAD_RUN_PATH) {
		throw new UploadApiError('INVALID_UPLOAD_REQUEST', 'Upload run creation route is invalid', 404);
	}
	if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== UPLOAD_ZIP_MEDIA_TYPE) {
		throw new UploadApiError('UNSUPPORTED_UPLOAD_MEDIA_TYPE', `Content-Type must be ${UPLOAD_ZIP_MEDIA_TYPE}`, 415);
	}

	const origin = request.headers.get('Origin');
	if (origin && origin !== url.origin) {
		throw new UploadApiError('CROSS_ORIGIN_UPLOAD', 'Cross-origin upload run creation is not allowed', 403);
	}
	const fetchSite = request.headers.get('Sec-Fetch-Site')?.toLowerCase();
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		throw new UploadApiError('CROSS_ORIGIN_UPLOAD', 'Cross-site upload run creation is not allowed', 403);
	}

	const contentLength = validateContentLength(request.headers.get('Content-Length'), contentLengthPolicy, maxBytes);
	if (!request.body || request.bodyUsed) {
		throw new UploadApiError('UPLOAD_BODY_REQUIRED', 'A readable upload body is required', 400);
	}

	return { body: request.body, contentLength };
}

export function limitUploadStream(source: ReadableStream<Uint8Array>, maxBytes: number = MAX_UPLOAD_BYTES): ReadableStream<Uint8Array> {
	const limit = validateMaxBytes(maxBytes);
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = source.getReader();
	} catch (error) {
		throw new UploadApiError('INVALID_UPLOAD_STREAM', 'Upload body stream is unavailable', 400, { cause: error });
	}

	let bytesRead = 0;
	let finished = false;
	let released = false;
	const releaseReader = () => {
		if (released) return;
		try {
			reader.releaseLock();
			released = true;
		} catch {
			// A concurrent cancellation owns the pending read and releases it when settled.
		}
	};
	const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, error: UploadApiError) => {
		finished = true;
		controller.error(error);
		try {
			await reader.cancel(error);
		} catch {
			// Preserve the boundary error even if the source also fails during cancellation.
		} finally {
			releaseReader();
		}
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (finished) return;
				if (result.done) {
					finished = true;
					releaseReader();
					controller.close();
					return;
				}
				if (!(result.value instanceof Uint8Array)) {
					await fail(controller, new UploadApiError('INVALID_UPLOAD_STREAM', 'Upload stream must contain byte chunks', 400));
					return;
				}
				if (result.value.byteLength > limit - bytesRead) {
					await fail(controller, uploadTooLarge(limit));
					return;
				}
				bytesRead += result.value.byteLength;
				controller.enqueue(result.value);
			} catch (error) {
				if (finished) return;
				finished = true;
				releaseReader();
				throw error;
			}
		},
		async cancel(reason) {
			if (finished) return;
			finished = true;
			try {
				await reader.cancel(reason);
			} finally {
				releaseReader();
			}
		},
	});
}

export function uploadRunR2Prefix(runId: unknown): string {
	return `runs/${validateUuid(runId, 'runId')}/`;
}

export function uploadSourceR2Key(runId: unknown): string {
	return `${uploadRunR2Prefix(runId)}source/upload.zip`;
}

export function siteSlugForUuid(siteId: unknown): string {
	return validateSiteSlug(`site-${validateUuid(siteId, 'siteId')}`);
}

export function validateSiteHostnameSuffix(value: unknown): string {
	return validateHostname(value);
}

export function siteHostnameForUuid(siteId: unknown, hostnameSuffix: unknown): string {
	const slug = siteSlugForUuid(siteId);
	const suffix = validateSiteHostnameSuffix(hostnameSuffix);
	return validateHostname(`${slug}.${suffix}`);
}

export async function rollbackUploadSource(bucket: UploadCleanupBucket, runId: unknown): Promise<void> {
	await bucket.delete(uploadSourceR2Key(runId));
}

function validateContentLength(header: string | null, policy: UploadContentLengthPolicy, maxBytes: number): number | null {
	if (header === null) {
		if (policy === 'required') {
			throw new UploadApiError('CONTENT_LENGTH_REQUIRED', 'Content-Length is required for upload run creation', 411);
		}
		return null;
	}
	if (!/^\d+$/.test(header)) {
		throw new UploadApiError('INVALID_CONTENT_LENGTH', 'Content-Length must be a positive integer', 400);
	}
	const contentLength = Number(header);
	if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
		throw new UploadApiError('INVALID_CONTENT_LENGTH', 'Content-Length must be a positive safe integer', 400);
	}
	if (contentLength > maxBytes) throw uploadTooLarge(maxBytes);
	return contentLength;
}

function validateContentLengthPolicy(value: unknown): UploadContentLengthPolicy {
	if (value !== 'optional' && value !== 'required') {
		throw invalidConfig('contentLengthPolicy must be optional or required');
	}
	return value;
}

function validateMaxBytes(value: unknown): number {
	const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
	if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0 || (parsed as number) > MAX_UPLOAD_BYTES) {
		throw invalidConfig(`maxBytes must be a positive integer no greater than ${MAX_UPLOAD_BYTES}`);
	}
	return parsed as number;
}

function validateUuid(value: unknown, name: 'runId' | 'siteId'): string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a UUID`);
	return value.toLowerCase();
}

function uploadTooLarge(limit: number): UploadApiError {
	return new UploadApiError('UPLOAD_TOO_LARGE', `Upload exceeds the ${limit} byte limit`, 413);
}

function invalidConfig(message: string, cause?: unknown): UploadApiError {
	return new UploadApiError('INVALID_UPLOAD_CONFIG', message, 503, cause === undefined ? undefined : { cause });
}
