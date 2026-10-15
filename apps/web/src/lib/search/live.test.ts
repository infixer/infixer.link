import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveSearch } from './live';

interface Pending {
	query: string;
	signal: AbortSignal;
	resolve: (value: string) => void;
	reject: (error: unknown) => void;
}

function setup(delay = 200) {
	const requests: Pending[] = [];
	const results: [string, string][] = [];
	const errors: string[] = [];
	const search = createLiveSearch<string>({
		delay,
		fetchResults: (query, signal) =>
			new Promise((resolve, reject) => requests.push({ query, signal, resolve, reject })),
		onResult: (query, result) => results.push([query, result]),
		onError: (query) => errors.push(query)
	});
	return { search, requests, results, errors };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createLiveSearch', () => {
	it('debounces input into one request for the last query', async () => {
		const { search, requests } = setup();
		search.schedule('読');
		await vi.advanceTimersByTimeAsync(100);
		search.schedule('読書');
		await vi.advanceTimersByTimeAsync(199);
		expect(requests).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(requests.map((r) => r.query)).toEqual(['読書']);
	});

	it('aborts the previous request and ignores its late response', async () => {
		const { search, requests, results } = setup();
		void search.run('読');
		void search.run('読書');
		expect(requests[0]!.signal.aborted).toBe(true);
		expect(requests[1]!.signal.aborted).toBe(false);

		requests[1]!.resolve('new');
		await vi.advanceTimersByTimeAsync(0);
		requests[0]!.resolve('old'); // a server that ignored the abort
		await vi.advanceTimersByTimeAsync(0);
		expect(results).toEqual([['読書', 'new']]);
	});

	it('reports errors only for the latest request, never for aborted ones', async () => {
		const { search, requests, errors } = setup();
		void search.run('a');
		void search.run('ab');
		requests[0]!.reject(new DOMException('aborted', 'AbortError'));
		requests[1]!.reject(new Error('offline'));
		await vi.advanceTimersByTimeAsync(0);
		expect(errors).toEqual(['ab']);
	});

	it('cancel drops a scheduled run and the response in flight', async () => {
		const { search, requests, results } = setup();
		void search.run('a');
		search.schedule('ab');
		search.cancel();
		await vi.advanceTimersByTimeAsync(500);
		requests[0]!.resolve('late');
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toHaveLength(1);
		expect(results).toEqual([]);
	});
});
