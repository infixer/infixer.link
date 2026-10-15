/**
 * Per-page locks across tabs (Web Locks API) so the open editor and the background
 * outbox sync never send the same page at the same time. Without the API (very old
 * browsers) everything still works; mutationIds keep retries idempotent.
 */
const name = (pageId: string) => `infixer-link:page:${pageId}`;

/**
 * Taken by an editor before it reads its draft, and held until the returned release
 * function is called. If the background sync is sending this page, the editor waits for
 * it (so it reads the result instead of sending the same draft again). Another tab
 * editing the same page may hold it for long: after `waitMs` the editor goes on without
 * the lock, as before Phase 6 (mutationIds keep retries idempotent).
 */
export async function acquirePageLock(pageId: string, waitMs = 3000): Promise<() => void> {
	if (!('locks' in navigator)) return () => {};
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), waitMs);
	return new Promise((acquired) => {
		navigator.locks
			.request(name(pageId), { signal: timeout.signal }, () => {
				clearTimeout(timer);
				acquired(release);
				return held;
			})
			.catch(() => acquired(() => {})); // timed out: continue without the lock
	});
}

export async function withPageLock<T>(pageId: string, fn: () => Promise<T>): Promise<T | 'busy'> {
	if (!('locks' in navigator)) return fn();
	return navigator.locks.request(name(pageId), { ifAvailable: true }, (lock) =>
		lock ? fn() : ('busy' as const)
	);
}
