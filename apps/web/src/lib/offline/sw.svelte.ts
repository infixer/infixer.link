/**
 * Service Worker registration and safe updates (design §4.4, ADR 0015).
 * A new version waits until the owner presses "更新"; drafts are flushed first and only
 * then the page reloads. Nothing reloads by itself while someone is editing.
 */
import { dev } from '$app/env';
import { flushAll } from './flush.ts';

export const sw = $state({ updateReady: false });

let registration: ServiceWorkerRegistration | undefined;
let accepted = false;

/**
 * Owner devices only (OfflineStatus): readers do not download the app shell in the
 * background. Not in `vite dev` (the build manifest only exists in builds).
 */
export async function registerServiceWorker() {
	if (dev || registration || !('serviceWorker' in navigator)) return;
	try {
		registration = await navigator.serviceWorker.register('/service-worker.js', {
			type: 'module'
		});
	} catch {
		return; // e.g. private mode: the site still works online
	}
	const reg = registration;
	const watch = (worker: ServiceWorker | null) =>
		worker?.addEventListener('statechange', () => {
			if (worker.state === 'installed' && navigator.serviceWorker.controller) sw.updateReady = true;
		});
	if (reg.waiting && navigator.serviceWorker.controller) sw.updateReady = true;
	watch(reg.installing);
	reg.addEventListener('updatefound', () => watch(reg.installing));
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (accepted) location.reload();
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void reg.update().catch(() => {});
	});
}

export async function applyUpdate() {
	await flushAll();
	accepted = true;
	registration?.waiting?.postMessage('skip-waiting');
}
