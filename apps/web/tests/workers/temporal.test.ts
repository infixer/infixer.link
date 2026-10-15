import { describe, expect, it } from 'vitest';
import { Temporal, formatDailyDate, temporalSource, today } from '@garden/time';

describe('Temporal in workerd', () => {
	it('resolves the JST calendar date with IANA time zone data', () => {
		expect(['native', 'polyfill']).toContain(temporalSource);
		const instant = Temporal.Instant.from('2026-10-15T15:30:00Z');
		expect(formatDailyDate(today('Asia/Tokyo', instant))).toBe('2026-10-16');
		expect(formatDailyDate(today('America/New_York', instant))).toBe('2026-10-15');
	});
});
