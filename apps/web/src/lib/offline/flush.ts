/** Things to write to IndexedDB before the page reloads (e.g. for an app update). */
const flushers = new Set<() => Promise<void>>();

export function registerFlush(fn: () => Promise<void>): () => void {
	flushers.add(fn);
	return () => flushers.delete(fn);
}

export async function flushAll(): Promise<void> {
	await Promise.allSettled([...flushers].map((fn) => fn()));
}
