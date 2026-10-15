import { describe, expect, it } from 'vitest';
import {
	Temporal,
	addDays,
	epochMsToIso,
	formatDailyDate,
	parseDailyDate,
	today
} from './index.ts';

const instant = (iso: string) => Temporal.Instant.from(iso);

describe('today', () => {
	it('uses Asia/Tokyo by default, not UTC', () => {
		// 2026-10-15T15:30Z is 2026-10-16 00:30 in JST
		expect(formatDailyDate(today(undefined, instant('2026-10-15T15:30:00Z')))).toBe('2026-10-16');
		expect(formatDailyDate(today(undefined, instant('2026-10-15T14:59:59Z')))).toBe('2026-10-15');
	});

	it('respects an explicitly configured time zone', () => {
		expect(formatDailyDate(today('UTC', instant('2026-10-15T15:30:00Z')))).toBe('2026-10-15');
		expect(formatDailyDate(today('America/Los_Angeles', instant('2026-10-15T05:00:00Z')))).toBe(
			'2026-10-14'
		);
	});
});

describe('parseDailyDate', () => {
	it('accepts valid dates including leap days', () => {
		expect(parseDailyDate('2028-02-29')?.toString()).toBe('2028-02-29');
	});

	it('rejects invalid or non-canonical input', () => {
		for (const value of ['2026-02-29', '2026-13-01', '2026-1-01', '20261015', '', '2026-10-15T00:00']) {
			expect(parseDailyDate(value)).toBeNull();
		}
	});
});

describe('addDays', () => {
	it('crosses month, year and leap boundaries by calendar', () => {
		expect(addDays(parseDailyDate('2026-10-31')!, 1).toString()).toBe('2026-11-01');
		expect(addDays(parseDailyDate('2026-12-31')!, 1).toString()).toBe('2027-01-01');
		expect(addDays(parseDailyDate('2028-03-01')!, -1).toString()).toBe('2028-02-29');
	});
});

describe('epochMsToIso', () => {
	it('formats server timestamps as ISO 8601 UTC', () => {
		expect(epochMsToIso(Date.UTC(2026, 9, 15, 0, 0, 0))).toBe('2026-10-15T00:00:00Z');
	});
});
