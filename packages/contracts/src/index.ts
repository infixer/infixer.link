/**
 * API contract shared by the web app and the CLI (design §8).
 * DTOs are deliberately separate from DB rows.
 */
import * as v from 'valibot';

export const LIMITS = {
	sourceBytes: 256 * 1024,
	titleCodePoints: 200,
	linksPerPage: 1000,
	assetsPerPage: 200,
	listDefault: 30,
	listMax: 100,
	/** Search (design §11.1): query length in code points, terms, page size and depth. */
	searchQueryCodePoints: 100,
	searchTerms: 5,
	searchDefault: 20,
	searchMax: 50,
	searchMaxOffset: 200
} as const;

export const FORMAT = 'link-text-v1';

export type ErrorCode =
	| 'bad_request'
	| 'validation_failed'
	| 'unauthenticated'
	| 'forbidden'
	| 'csrf_failed'
	| 'reauth_required'
	| 'not_found'
	| 'revision_conflict'
	| 'mutation_conflict'
	| 'name_conflict'
	| 'daily_conflict'
	| 'page_deleted'
	| 'payload_too_large'
	| 'unsupported_media_type'
	| 'rate_limited'
	| 'setup_unavailable'
	| 'last_passkey'
	| 'internal_error';

export interface ApiErrorBody {
	code: ErrorCode;
	message: string;
	requestId: string;
	retryable: boolean;
	details?: Record<string, unknown>;
}

const uuid = v.pipe(v.string(), v.uuid());
const revision = v.pipe(v.number(), v.integer(), v.minValue(1));
const title = v.pipe(
	v.string(),
	v.check((s) => s.trim().length > 0, 'title must not be empty'),
	v.check((s) => !/[\r\n]/.test(s), 'title must be a single line'),
	v.check((s) => [...s].length <= LIMITS.titleCodePoints, 'title is too long')
);
const source = v.pipe(
	v.string(),
	v.check((s) => !s.includes('\r'), 'source must use LF line endings')
);
const format = v.literal(FORMAT);
const dailyDate = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));

export const CreatePageRequest = v.strictObject({
	id: v.optional(uuid),
	mutationId: uuid,
	title,
	format,
	source,
	dailyDate: v.optional(dailyDate)
});
export type CreatePageRequest = v.InferOutput<typeof CreatePageRequest>;

export const UpdatePageRequest = v.strictObject({
	baseRevision: revision,
	mutationId: uuid,
	title,
	format,
	source
});
export type UpdatePageRequest = v.InferOutput<typeof UpdatePageRequest>;

export const DeletePageRequest = v.strictObject({
	baseRevision: revision,
	mutationId: uuid
});
export type DeletePageRequest = v.InferOutput<typeof DeletePageRequest>;

export const RestorePageRequest = v.strictObject({
	baseRevision: revision,
	mutationId: uuid,
	/** Revision whose content to restore. Defaults to the last non-deleted revision. */
	fromRevision: v.optional(revision)
});
export type RestorePageRequest = v.InferOutput<typeof RestorePageRequest>;

export const DailyPageRequest = v.strictObject({
	mutationId: uuid
});
export type DailyPageRequest = v.InferOutput<typeof DailyPageRequest>;

export interface DailyPageDto {
	pageId: string;
	title: string;
	revision: number;
	dailyDate: string;
	/** False when the daily page already existed. */
	created: boolean;
}

export interface MutationResult {
	pageId: string;
	revision: number;
	updatedAt: string;
	changeSeq: number;
	mutationId: string;
	/** True when the response replays an already-applied mutation. */
	replayed: boolean;
}

export interface PageDto {
	id: string;
	title: string;
	format: typeof FORMAT;
	source: string;
	revision: number;
	dailyDate: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface OwnerPageDto extends PageDto {
	deletedAt: string | null;
}

export interface PageSummaryDto {
	id: string;
	title: string;
	revision: number;
	dailyDate: string | null;
	updatedAt: string;
}

export interface PageListDto {
	pages: PageSummaryDto[];
	nextCursor: string | null;
}

export interface RevisionDto {
	revision: number;
	operation: 'create' | 'update' | 'delete' | 'restore';
	title: string;
	deleted: boolean;
	createdAt: string;
}

export interface ResolveDto {
	pageId: string;
	title: string;
	matchedAlias: boolean;
}

export type SessionDto =
	| { authenticated: false }
	| {
			authenticated: true;
			csrfToken: string;
			reauthenticatedAt: string;
			expiresAt: string;
	  };

export const PasskeyNameRequest = v.strictObject({
	name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
});

export const SetupOptionsRequest = v.strictObject({
	token: v.pipe(v.string(), v.minLength(32), v.maxLength(256))
});

export const AuthenticationOptionsRequest = v.strictObject({
	purpose: v.picklist(['login', 'reauth'])
});

/** WebAuthn response JSON as produced by @simplewebauthn/browser; verified in depth server-side. */
const credentialResponse = v.looseObject({
	id: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
	rawId: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
	type: v.literal('public-key'),
	response: v.looseObject({ clientDataJSON: v.string() }),
	clientExtensionResults: v.optional(v.looseObject({}), {})
});

export const RegistrationVerifyRequest = v.strictObject({
	response: v.looseObject({
		...credentialResponse.entries,
		response: v.looseObject({ clientDataJSON: v.string(), attestationObject: v.string() })
	}),
	name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)))
});

export const AuthenticationVerifyRequest = v.strictObject({
	response: v.looseObject({
		...credentialResponse.entries,
		response: v.looseObject({
			clientDataJSON: v.string(),
			authenticatorData: v.string(),
			signature: v.string(),
			userHandle: v.optional(v.string())
		})
	})
});

export interface AuthenticationResultDto {
	authenticated: true;
	purpose: 'login' | 'reauth';
}

export interface PasskeyDto {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt: string | null;
	backedUp: boolean;
	deviceType: string;
	current: boolean;
}

export interface SessionSummaryDto {
	id: string;
	userAgent: string;
	createdAt: string;
	lastSeenAt: string;
	current: boolean;
}

export interface AssetDto {
	id: string;
	status: 'pending' | 'ready' | 'rejected';
	/** Public URL of the immutable original (ready only). */
	url: string | null;
	width: number | null;
	height: number | null;
	mime: string | null;
}

export interface LinkPreviewDto {
	url: string;
	ok: boolean;
	title: string | null;
	description: string | null;
	siteName: string | null;
	host: string;
	/** Card image copied into R2 (never hotlinked). */
	image: { url: string; width: number; height: number } | null;
}

export const LinkPreviewsRequest = v.strictObject({
	urls: v.pipe(
		v.array(v.pipe(v.string(), v.maxLength(2048), v.regex(/^https?:\/\//i))),
		v.minLength(1),
		v.maxLength(20)
	)
});

export const NamesResolveRequest = v.strictObject({
	names: v.pipe(v.array(v.pipe(v.string(), v.maxLength(400))), v.maxLength(1000))
});

export interface PageRefDto {
	id: string;
	title: string;
}

/** A link target: resolved to a live page, or a name without a page yet. */
export interface LinkTargetDto {
	name: string;
	page: PageRefDto | null;
}

export interface RelatedDto {
	/** Pages / names this page links to. */
	links: LinkTargetDto[];
	/** Pages linking to this page (any of its names). */
	backlinks: PageRefDto[];
	/** Other pages sharing a link target with this page, grouped by target. */
	shared: { target: LinkTargetDto; pages: PageRefDto[]; more: boolean }[];
}

export interface TitleSuggestionDto {
	title: string;
	pageId: string;
	alias: boolean;
}

/** Why a page matched: its current title, an earlier name (alias), or only the body. */
export type SearchMatch = 'title' | 'alias' | 'body';

export interface SearchHitDto {
	id: string;
	title: string;
	dailyDate: string | null;
	updatedAt: string;
	match: SearchMatch;
	/** Matched name when `match` is 'alias'. */
	alias: string | null;
	/** Body excerpt around the first match, split into plain and highlighted parts. */
	excerpt: { text: string; hit: boolean }[];
}

export interface SearchDto {
	/** The normalized query that was executed ('' when nothing was searched). */
	query: string;
	hits: SearchHitDto[];
	/** Offset for the next page, or null when there are no more (or the depth limit was reached). */
	nextOffset: number | null;
}

export { v };
