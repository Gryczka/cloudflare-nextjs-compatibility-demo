import { describe, expect, it } from 'vitest';
import { discovery, gardenUrl, resourceAnchors } from '../src/garden';

describe('public discovery contract', () => {
	it('preserves Cloudflare URL query parameters/fragments and decorates anchors only', () => {
		const raw = 'https://developers.cloudflare.com/workers/?lang=en#limits';
		const url = new URL(gardenUrl(raw));
		expect(url.searchParams.get('lang')).toBe('en');
		expect(url.hash).toBe('#limits');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			utm_source: 'gryczka.dev',
			utm_medium: 'referral',
			utm_campaign: 'app-garden',
			utm_content: 'nextjs-compatibility-lab-workers',
			utm_term: 'workers',
		});
		const html = resourceAnchors(`<a href="${raw}">Docs</a><code>${raw}</code>`);
		expect(html).toContain('&amp;utm_source=gryczka.dev');
		expect(html).toContain(`<code>${raw}</code>`);
		expect(gardenUrl('https://cloudflare.com.evil.example/')).toBe('https://cloudflare.com.evil.example/');
	});
	it('excludes private execution paths from the sitemap', async () => {
		expect(await discovery('/robots.txt')!.text()).toContain('Content-Signal: search=yes,ai-input=yes,ai-train=no');
		expect(await discovery('/robots.txt')!.text()).toContain('Disallow: /customer-environments/');
		expect(await discovery('/sitemap.xml')!.text()).not.toContain('/api/runs');
		expect(discovery('/api/runs')).toBeNull();
	});
});
