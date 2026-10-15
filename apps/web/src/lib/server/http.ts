import type { ApiErrorBody, ErrorCode } from '@infixer-link/contracts';
import { epochMsToIso } from '@infixer-link/time';

const STATUS: Record<ErrorCode, number> = {
	bad_request: 400,
	validation_failed: 422,
	unauthenticated: 401,
	forbidden: 403,
	csrf_failed: 403,
	reauth_required: 403,
	not_found: 404,
	revision_conflict: 409,
	mutation_conflict: 409,
	name_conflict: 409,
	daily_conflict: 409,
	page_deleted: 409,
	payload_too_large: 413,
	unsupported_media_type: 415,
	rate_limited: 429,
	setup_unavailable: 403,
	last_passkey: 409,
	internal_error: 500
};

const RETRYABLE = new Set<ErrorCode>(['rate_limited', 'internal_error']);

export class ApiError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly details?: Record<string, unknown>
	) {
		super(message);
	}

	get status(): number {
		return STATUS[this.code];
	}
}

export const NO_STORE = { 'cache-control': 'no-store' } as const;

export function jsonResponse(data: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
	return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

export function errorResponse(error: unknown, requestId: string): Response {
	const apiError =
		error instanceof ApiError ? error : new ApiError('internal_error', 'Internal error');
	if (!(error instanceof ApiError)) {
		// Never log bodies, cookies or tokens; the message of a D1/runtime error is enough.
		console.error(`[${requestId}] unhandled`, error instanceof Error ? error.message : error);
	}
	const body: ApiErrorBody = {
		code: apiError.code,
		message: apiError.message,
		requestId,
		retryable: RETRYABLE.has(apiError.code),
		...(apiError.details ? { details: apiError.details } : {})
	};
	return jsonResponse(body, { status: apiError.status, headers: NO_STORE });
}

export function toIso(ms: number): string;
export function toIso(ms: number | null): string | null;
export function toIso(ms: number | null): string | null {
	return ms === null ? null : epochMsToIso(ms);
}
