/**
 * Search-as-you-type (design §11.1): debounce input, abort the previous request,
 * and never let an older response overwrite a newer one.
 */
export interface LiveSearchOptions<T> {
	/** Debounce in ms (design: 150–250ms). */
	delay?: number;
	fetchResults: (query: string, signal: AbortSignal) => Promise<T>;
	onResult: (query: string, result: T) => void;
	onError?: (query: string, error: unknown) => void;
}

export function createLiveSearch<T>(options: LiveSearchOptions<T>) {
	const delay = options.delay ?? 200;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let latest = 0;

	function cancel() {
		clearTimeout(timer);
		controller?.abort();
		controller = undefined;
		latest++;
	}

	/** Runs immediately (e.g. on submit), superseding anything scheduled or in flight. */
	async function run(query: string) {
		cancel();
		const ticket = latest;
		const current = new AbortController();
		controller = current;
		try {
			const result = await options.fetchResults(query, current.signal);
			if (ticket === latest) options.onResult(query, result);
		} catch (error) {
			if (ticket === latest && !current.signal.aborted) options.onError?.(query, error);
		} finally {
			if (controller === current) controller = undefined;
		}
	}

	/** Debounced run for input events. */
	function schedule(query: string) {
		clearTimeout(timer);
		timer = setTimeout(() => void run(query), delay);
	}

	return { schedule, run, cancel };
}
