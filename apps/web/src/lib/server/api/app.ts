/**
 * JSON API (design §8) built with Hono and served from the same Worker as the
 * SvelteKit pages via `src/routes/api/[...path]/+server.ts` (ADR 0006).
 *
 * The app is created from explicit dependencies so integration tests can call
 * `app.request()` inside workerd without SvelteKit.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { sValidator } from '@hono/standard-validator';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
	AuthenticationOptionsRequest,
	AuthenticationVerifyRequest,
	CreatePageRequest,
	DailyPageRequest,
	LinkPreviewsRequest,
	DeletePageRequest,
	PasskeyNameRequest,
	RegistrationVerifyRequest,
	RestorePageRequest,
	SetupOptionsRequest,
	UpdatePageRequest,
	NamesResolveRequest,
	type SessionDto
} from '@infixer-link/contracts';
import { temporalSource } from '@infixer-link/time';
import { AUTH_TIMING, type AuthConfig } from '../config';
import { ApiError, errorResponse, toIso } from '../http';
import * as auth from '../auth/service';
import * as pages from '../pages/service';
import * as graph from '../pages/graph';
import { refreshPreviews, type Fetcher } from '../previews';

export interface ApiDeps {
	db: D1Database;
	config: AuthConfig;
	now?: () => number;
	/** Outbound fetch for link previews (injected in tests). */
	fetcher?: Fetcher;
	/** Local development only: allow previews of http://localhost URLs. */
	allowLocalPreviews?: boolean;
}

type AppEnv = {
	Variables: {
		requestId: string;
		now: number;
		session: auth.SessionRecord | null;
	};
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_WINDOW_MS = 10 * 60 * 1000;

function clientIp(c: Context): string {
	return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/** JSON body validator: 415 for non-JSON, 422 with issue paths for schema failures. */
function json<S extends StandardSchemaV1>(schema: S) {
	const requireJson: MiddlewareHandler = async (c, next) => {
		const type = c.req.header('content-type') ?? '';
		if (!/^application\/json\b/i.test(type)) {
			throw new ApiError('unsupported_media_type', 'Expected application/json');
		}
		await next();
	};
	const validate = sValidator('json', schema, (result) => {
		if (!result.success) {
			throw new ApiError('validation_failed', 'Request validation failed', {
				issues: result.error.map((i) => ({
					path: (i.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)).join('.'),
					message: i.message
				}))
			});
		}
	});
	return [requireJson, validate] as const;
}

export function createApi(deps: ApiDeps) {
	const { db, config } = deps;
	const clock = deps.now ?? Date.now;
	const authDeps = { db, config };

	const cookieBase = {
		path: '/',
		httpOnly: true,
		secure: config.secureCookies,
		sameSite: 'Lax' as const
	};

	function setSessionCookie(c: Context, issued: auth.IssuedSession) {
		setCookie(c, config.sessionCookie, issued.token, {
			...cookieBase,
			maxAge: issued.maxAgeSeconds
		});
	}

	function setCeremonyCookie(c: Context, value: string) {
		setCookie(c, config.ceremonyCookie, value, {
			...cookieBase,
			sameSite: 'Strict',
			maxAge: AUTH_TIMING.challengeTtlMs / 1000
		});
	}

	function takeCeremonyCookie(c: Context): string | undefined {
		const value = getCookie(c, config.ceremonyCookie);
		deleteCookie(c, config.ceremonyCookie, { path: '/', secure: config.secureCookies });
		return value;
	}

	/** Host + Origin checks for authentication and owner routes (design §9.4, §9.8). */
	const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
		const requestOrigin = new URL(c.req.url).origin;
		if (!config.origins.includes(requestOrigin)) {
			throw new ApiError('forbidden', 'Host not allowed');
		}
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
			const origin = c.req.header('origin');
			if (!origin || !config.origins.includes(origin)) {
				throw new ApiError('forbidden', 'Origin not allowed');
			}
		}
		await next();
	};

	/** Resolves the cookie session. Bearer tokens arrive in Phase 7; mixing is rejected. */
	const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
		if (c.req.header('authorization')) {
			throw new ApiError('unauthenticated', 'Bearer tokens are not supported yet');
		}
		c.set('session', await auth.getSession(db, getCookie(c, config.sessionCookie), c.get('now')));
		await next();
	};

	const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
		const session = c.get('session');
		if (!session) throw new ApiError('unauthenticated', 'Sign in required');
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
			auth.checkCsrf(session, c.req.header('x-csrf-token'));
		}
		await next();
	};

	const authLimit =
		(name: string, limit: number): MiddlewareHandler<AppEnv> =>
		async (c, next) => {
			await auth.rateLimit(db, `${name}:${clientIp(c)}`, limit, AUTH_WINDOW_MS, c.get('now'));
			await next();
		};

	const pageId: MiddlewareHandler<AppEnv> = async (c, next) => {
		if (!UUID_RE.test(c.req.param('id') ?? '')) throw new ApiError('not_found', 'Page not found');
		await next();
	};

	const app = new Hono<AppEnv>().basePath('/api');

	app.use(async (c, next) => {
		const requestId = crypto.randomUUID();
		c.set('requestId', requestId);
		c.set('now', clock());
		c.set('session', null);
		await next();
		c.header('x-request-id', requestId);
		if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
	});

	app.use(
		bodyLimit({
			maxSize: 512 * 1024,
			onError: () => {
				throw new ApiError('payload_too_large', 'Request body is too large');
			}
		})
	);

	app.onError((error, c) => {
		if (error instanceof HTTPException && !(error instanceof ApiError)) {
			const code = error.status === 413 ? 'payload_too_large' : 'bad_request';
			return errorResponse(new ApiError(code, error.message || 'Bad request'), c.get('requestId'));
		}
		return errorResponse(error, c.get('requestId'));
	});

	app.notFound((c) => errorResponse(new ApiError('not_found', 'Not found'), c.get('requestId')));

	// --- health ---------------------------------------------------------------

	app.get('/health', async (c) => {
		let ok = true;
		try {
			await db.prepare('SELECT 1').first();
		} catch {
			ok = false;
		}
		return c.json(
			{ status: ok ? 'ok' : 'degraded', db: ok ? 'ok' : 'error', temporal: temporalSource },
			ok ? 200 : 503
		);
	});

	// --- public (no auth, no session lookup) ------------------------------------

	const publicApi = new Hono<AppEnv>()
		.get('/pages', async (c) => {
			const limit = c.req.query('limit');
			const result = await pages.listPages(db, {
				cursor: c.req.query('cursor') || undefined,
				limit: limit ? Number.parseInt(limit, 10) || undefined : undefined
			});
			c.header('cache-control', 'no-cache');
			return c.json(result);
		})
		.get('/pages/:id', pageId, async (c) => {
			const page = await pages.getPublicPage(db, c.req.param('id'));
			if (!page) throw new ApiError('not_found', 'Page not found');
			const etag = `"${page.id}:${page.revision}"`;
			c.header('cache-control', 'no-cache');
			c.header('etag', etag);
			if (c.req.header('if-none-match') === etag) return c.body(null, 304);
			return c.json(page);
		})
		.get('/pages/:id/related', pageId, async (c) => {
			c.header('cache-control', 'no-cache');
			return c.json(await graph.relatedPages(db, c.req.param('id')));
		})
		.get('/resolve', async (c) => {
			const title = c.req.query('title') ?? '';
			if (!title.trim() || title.length > 400)
				throw new ApiError('bad_request', 'title is required');
			const resolved = await pages.resolveName(db, title);
			if (!resolved) throw new ApiError('not_found', 'No page with this name');
			c.header('cache-control', 'no-cache');
			return c.json(resolved);
		});

	// --- authentication -----------------------------------------------------------

	const authApi = new Hono<AppEnv>()
		.use(sameOrigin, loadSession)
		.get('/session', (c) => {
			const session = c.get('session');
			const body: SessionDto = session
				? {
						authenticated: true,
						csrfToken: session.csrfToken,
						reauthenticatedAt: toIso(session.reauthenticatedAt),
						expiresAt: toIso(session.absoluteExpiresAt)
					}
				: { authenticated: false };
			return c.json(body);
		})
		.post('/setup/options', authLimit('setup', 10), ...json(SetupOptionsRequest), async (c) => {
			const { token } = c.req.valid('json');
			const result = await auth.setupOptions(authDeps, token, c.get('now'));
			setCeremonyCookie(c, result.ceremony);
			return c.json({ purpose: result.purpose, options: result.options });
		})
		.post(
			'/setup/verify',
			authLimit('setup', 10),
			...json(RegistrationVerifyRequest),
			async (c) => {
				const body = c.req.valid('json');
				const issued = await auth.setupVerify(
					authDeps,
					takeCeremonyCookie(c),
					body.response as unknown as RegistrationResponseJSON,
					{ name: body.name, userAgent: c.req.header('user-agent') ?? '', now: c.get('now') }
				);
				setSessionCookie(c, issued);
				return c.json({ authenticated: true as const });
			}
		)
		.post(
			'/authentication/options',
			authLimit('auth', 30),
			...json(AuthenticationOptionsRequest),
			async (c) => {
				const { purpose } = c.req.valid('json');
				const session = c.get('session');
				if (purpose === 'reauth' && session) auth.checkCsrf(session, c.req.header('x-csrf-token'));
				const result = await auth.authenticationOptions(authDeps, purpose, session, c.get('now'));
				setCeremonyCookie(c, result.ceremony);
				return c.json({ options: result.options });
			}
		)
		.post(
			'/authentication/verify',
			authLimit('auth', 30),
			...json(AuthenticationVerifyRequest),
			async (c) => {
				const body = c.req.valid('json');
				const result = await auth.authenticationVerify(
					authDeps,
					takeCeremonyCookie(c),
					body.response as unknown as AuthenticationResponseJSON,
					{
						session: c.get('session'),
						userAgent: c.req.header('user-agent') ?? '',
						now: c.get('now')
					}
				);
				if (result.issued) setSessionCookie(c, result.issued);
				return c.json({ authenticated: true as const, purpose: result.purpose });
			}
		)
		.post('/registration/options', requireOwner, async (c) => {
			const result = await auth.registrationOptions(authDeps, c.get('session')!, c.get('now'));
			setCeremonyCookie(c, result.ceremony);
			return c.json({ options: result.options });
		})
		.post('/registration/verify', requireOwner, ...json(RegistrationVerifyRequest), async (c) => {
			const body = c.req.valid('json');
			const result = await auth.registrationVerify(
				authDeps,
				takeCeremonyCookie(c),
				body.response as unknown as RegistrationResponseJSON,
				{ session: c.get('session')!, name: body.name, now: c.get('now') }
			);
			return c.json(result, 201);
		})
		.post('/logout', async (c) => {
			const session = c.get('session');
			if (session) {
				auth.checkCsrf(session, c.req.header('x-csrf-token'));
				await auth.revokeSession(db, session.id, c.get('now'));
			}
			deleteCookie(c, config.sessionCookie, { path: '/', secure: config.secureCookies });
			return c.json({ authenticated: false as const });
		});

	// --- owner ---------------------------------------------------------------

	const ownerApi = new Hono<AppEnv>()
		.use(sameOrigin, loadSession, requireOwner)
		.post('/pages', ...json(CreatePageRequest), async (c) => {
			const result = await pages.createPage(db, c.req.valid('json'), c.get('now'));
			return c.json(result, result.replayed ? 200 : 201);
		})
		.post('/daily/:date', ...json(DailyPageRequest), async (c) => {
			const result = await pages.getOrCreateDaily(
				db,
				c.req.param('date'),
				c.req.valid('json').mutationId,
				c.get('now')
			);
			return c.json(result, result.created ? 201 : 200);
		})
		.get('/pages/:id', pageId, async (c) => {
			const page = await pages.getOwnerPage(db, c.req.param('id'));
			if (!page) throw new ApiError('not_found', 'Page not found');
			return c.json(page);
		})
		.put('/pages/:id', pageId, ...json(UpdatePageRequest), async (c) =>
			c.json(await pages.updatePage(db, c.req.param('id'), c.req.valid('json'), c.get('now')))
		)
		.delete('/pages/:id', pageId, ...json(DeletePageRequest), async (c) =>
			c.json(await pages.deletePage(db, c.req.param('id'), c.req.valid('json'), c.get('now')))
		)
		.post('/pages/:id/restore', pageId, ...json(RestorePageRequest), async (c) =>
			c.json(await pages.restorePage(db, c.req.param('id'), c.req.valid('json'), c.get('now')))
		)
		.get('/titles', async (c) => {
			const limit = Number.parseInt(c.req.query('limit') ?? '', 10) || 20;
			return c.json({ titles: await graph.suggestTitles(db, c.req.query('q') ?? '', limit) });
		})
		.post('/names/resolve', ...json(NamesResolveRequest), async (c) =>
			c.json({ pages: await graph.resolveNames(db, c.req.valid('json').names) })
		)
		.post('/link-previews', ...json(LinkPreviewsRequest), async (c) =>
			c.json({
				previews: await refreshPreviews(db, c.req.valid('json').urls, {
					fetcher: deps.fetcher ?? ((input, init) => fetch(input, init)),
					allowLocal: deps.allowLocalPreviews ?? false,
					now: c.get('now')
				})
			})
		)
		.get('/pages/:id/revisions', pageId, async (c) => {
			const revisions = await pages.listRevisions(db, c.req.param('id'));
			if (!revisions) throw new ApiError('not_found', 'Page not found');
			return c.json({ revisions });
		})
		.get('/passkeys', async (c) =>
			c.json({ passkeys: await auth.listPasskeys(db, c.get('session')!) })
		)
		.patch('/passkeys/:id', ...json(PasskeyNameRequest), async (c) => {
			await auth.renamePasskey(db, c.req.param('id'), c.req.valid('json').name);
			return c.json({ ok: true as const });
		})
		.delete('/passkeys/:id', async (c) => {
			await auth.revokePasskey(db, c.get('session')!, c.req.param('id'), c.get('now'));
			return c.json({ ok: true as const });
		})
		.get('/sessions', async (c) =>
			c.json({ sessions: await auth.listSessions(db, c.get('session')!, c.get('now')) })
		)
		.delete('/sessions/:id', async (c) => {
			await auth.revokeSessionById(db, c.req.param('id'), c.get('now'));
			return c.json({ ok: true as const });
		})
		.post('/sessions/revoke-others', async (c) => {
			await auth.revokeOtherSessions(db, c.get('session')!, c.get('now'));
			return c.json({ ok: true as const });
		});

	return app.route('/public/v1', publicApi).route('/auth/v1', authApi).route('/owner/v1', ownerApi);
}

/** Typed client surface for `hono/client` (web and, in Phase 7, the CLI). */
export type ApiApp = ReturnType<typeof createApi>;
