import { message } from '../content.greeting';

export default function Page() {
	return (
		<main>
			<article>
				<p className="eyebrow">Next.js compatibility fixture</p>
				<h1>OpenNext fallback</h1>
				<code id="result">{message}</code>
			</article>
		</main>
	);
}
