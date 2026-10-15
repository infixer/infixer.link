import { env } from 'cloudflare:workers';
import { json } from '@sveltejs/kit';
import { temporalSource } from '@garden/time';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	let db: 'ok' | 'error' = 'ok';
	try {
		await env.DB.prepare('SELECT 1').first();
	} catch {
		db = 'error';
	}

	return json(
		{ status: db === 'ok' ? 'ok' : 'degraded', db, temporal: temporalSource },
		{ status: db === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
