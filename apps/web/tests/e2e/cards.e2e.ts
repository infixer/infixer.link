/** List cards and the YouTube player (ADR 0014). */
import { expect, test, type Page } from '@playwright/test';
import { createPage, ownerContext, solidPng, unique, uploadImage } from './helpers';

const VIDEO_LINE = 'https://youtu.be/dQw4w9WgXcQ?t=42';

/** Never reach YouTube from tests: the player request gets a stub page. */
async function stubPlayer(page: Page) {
	const requested: string[] = [];
	await page.route('https://www.youtube-nocookie.com/**', async (route) => {
		requested.push(route.request().url());
		await route.fulfill({ contentType: 'text/html', body: '<p>player</p>' });
	});
	return requested;
}

function cspErrors(page: Page) {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
	});
	return errors;
}

test('the home page shows cards with the first image, or the first lines of text', async ({
	browser,
	page
}) => {
	const owner = await ownerContext(browser);
	const image = await uploadImage(owner.request, solidPng(400, 300, [30, 140, 90]));
	const withImage = unique('画像のカード');
	const textOnly = unique('文字のカード');
	await createPage(owner.request, withImage, `前置き\n[asset:${image}]`);
	await createPage(owner.request, textOnly, '# 一行目\n[* 二行目] と [リンク]');
	await owner.close();

	await page.setViewportSize({ width: 375, height: 667 });
	await page.goto('/');
	const imageCard = page.getByRole('link', { name: withImage });
	await expect(imageCard.locator('img.thumb')).toHaveAttribute('width', '400');
	await expect
		.poll(() => imageCard.locator('img.thumb').evaluate((i: HTMLImageElement) => i.naturalWidth))
		.toBe(400);
	const textCard = page.getByRole('link', { name: textOnly });
	await expect(textCard.locator('.text')).toHaveText('一行目二行目 と リンク');
	await expect(textCard.locator('img')).toHaveCount(0);

	// Two square cards per row on a phone, without horizontal scrolling.
	const [a, b] = await page
		.getByTestId('page-list')
		.locator('li')
		.evaluateAll((items) => items.slice(0, 2).map((li) => li.getBoundingClientRect().toJSON()));
	expect(a.top).toBe(b.top);
	expect(Math.abs(a.width - a.height)).toBeLessThan(1);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);

	await imageCard.click();
	await expect(page.locator('h1')).toHaveText(withImage);
});

test('a YouTube line plays in the page only after pressing play', async ({ browser, page }) => {
	const owner = await ownerContext(browser);
	const { pageId } = await createPage(owner.request, unique('動画'), `見た動画\n${VIDEO_LINE}`);
	await owner.close();
	const requested = await stubPlayer(page);
	const errors = cspErrors(page);

	await page.goto(`/p/${pageId}/x`);
	const video = page.getByTestId('page-source').getByTestId('video');
	const box = await video.boundingBox();
	expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
	await expect(video.locator('iframe')).toHaveCount(0);
	expect(requested).toEqual([]);

	await video.getByRole('link', { name: 'YouTube の動画を再生' }).click();
	const frame = video.locator('iframe');
	await expect(frame).toHaveAttribute(
		'src',
		'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=42'
	);
	await expect.poll(() => requested.length).toBe(1);
	expect(errors).toEqual([]);
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('the video is a link to YouTube', async ({ browser, page }) => {
		const owner = await ownerContext(browser);
		const { pageId } = await createPage(owner.request, unique('動画 JS なし'), VIDEO_LINE);
		await owner.close();
		await page.goto(`/p/${pageId}/x`);
		await expect(page.getByTestId('video').locator('a')).toHaveAttribute(
			'href',
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'
		);
	});
});

test('the editor shows the player for lines without the cursor', async ({ browser }) => {
	test.skip(browser.browserType().name() !== 'chromium', 'editor interactions run once');
	const owner = await ownerContext(browser);
	const { pageId } = await createPage(owner.request, unique('動画の編集'), `一行目\n${VIDEO_LINE}`);
	const page = await owner.newPage();
	const requested = await stubPlayer(page);
	// Keep the Worker from looking the video up on YouTube during the test.
	await page.route('**/api/owner/v1/link-previews', (route) =>
		route.fulfill({ json: { previews: {} } })
	);
	await page.goto(`/p/${pageId}/x`);
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.locator('.cm-line').first().click();

	const video = page.locator('.cm-content [data-testid="video"]');
	await expect(video).toBeVisible();
	await video.locator('a').click();
	await expect(video.locator('iframe')).toHaveAttribute(
		'src',
		/youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/
	);
	await expect.poll(() => requested.length).toBe(1);
	// The source line is untouched by playing.
	await expect(page.getByTestId('save-state')).not.toHaveText('保存中…');
	await owner.close();
});
