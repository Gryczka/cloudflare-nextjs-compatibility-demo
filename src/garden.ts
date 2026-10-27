export const PUBLIC_ORIGIN = 'https://cloudflare-nextjs-compatibility-demo.dwarven.workers.dev';

/** Attribute resource anchors, preserving non-UTM query parameters and fragments. */
export function gardenUrl(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' || !/(^|\.)cloudflare\.com$/.test(url.hostname)) return raw;
		const parts = url.pathname.split('/').filter(Boolean);
		const product =
			parts.find((part) => ['workers', 'containers', 'sandbox', 'workers-for-platforms', 'durable-objects'].includes(part)) ?? 'workers';
		url.searchParams.set('utm_source', 'gryczka.dev');
		url.searchParams.set('utm_medium', 'referral');
		url.searchParams.set('utm_campaign', 'app-garden');
		url.searchParams.set('utm_content', `nextjs-compatibility-lab-${parts.join('-') || 'overview'}`);
		url.searchParams.set('utm_term', product);
		return url.href;
	} catch {
		return raw;
	}
}

/** Only trusted checked-in HTML passes through this anchor decorator. */
export function resourceAnchors(html: string): string {
	return html.replace(
		/(<a\b[^>]*\bhref=)(["'])([^"']+)\2/gi,
		(_match, prefix, quote, href) => `${prefix}${quote}${gardenUrl(href.replaceAll('&amp;', '&')).replaceAll('&', '&amp;')}${quote}`,
	);
}

export function discovery(path: string): Response | null {
	const headers = { 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' };
	if (path === '/robots.txt')
		return new Response(
			`User-agent: *\nContent-Signal: search=yes,ai-input=yes,ai-train=no\nAllow: /\nAllow: /api/fixtures$\nDisallow: /api/\nDisallow: /customer-environments/\nDisallow: /preview/\nDisallow: /uploads/\nSitemap: ${PUBLIC_ORIGIN}/sitemap.xml\n`,
			{ headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } },
		);
	if (path === '/sitemap.xml')
		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PUBLIC_ORIGIN}/</loc></url></urlset>`,
			{ headers: { ...headers, 'Content-Type': 'application/xml; charset=utf-8' } },
		);
	return null;
}
