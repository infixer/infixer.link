import { Temporal as TemporalPolyfill } from '@js-temporal/polyfill';

/**
 * Temporal access point for the whole project (design §5).
 * Uses the native implementation when the runtime provides one and
 * falls back to @js-temporal/polyfill otherwise. Types always come from the
 * polyfill so that callers see one consistent API surface.
 */
const nativeTemporal = (globalThis as unknown as { Temporal?: typeof TemporalPolyfill }).Temporal;

export const Temporal: typeof TemporalPolyfill = nativeTemporal ?? TemporalPolyfill;
export const temporalSource: 'native' | 'polyfill' = nativeTemporal ? 'native' : 'polyfill';

export type PlainDate = TemporalPolyfill.PlainDate;
export type Instant = TemporalPolyfill.Instant;

/** Default site time zone. Never derived implicitly from the device. */
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in the configured time zone. */
export function today(timeZone: string = DEFAULT_TIME_ZONE, now?: Instant): PlainDate {
	const instant = now ?? Temporal.Now.instant();
	return instant.toZonedDateTimeISO(timeZone).toPlainDate();
}

/** Parses a strict `YYYY-MM-DD` daily date. Returns null when invalid. */
export function parseDailyDate(value: string): PlainDate | null {
	if (!DATE_RE.test(value)) return null;
	try {
		return Temporal.PlainDate.from(value, { overflow: 'reject' });
	} catch {
		return null;
	}
}

/** `YYYY-MM-DD` used for DB storage and URLs. */
export function formatDailyDate(date: PlainDate): string {
	return date.toString();
}

/** Calendar arithmetic; never 24h millisecond math. */
export function addDays(date: PlainDate, days: number): PlainDate {
	return date.add({ days });
}

/** Server-issued timestamps are stored as epoch milliseconds (INTEGER). */
export function epochMsToIso(epochMs: number): string {
	return Temporal.Instant.fromEpochMilliseconds(epochMs).toString();
}
