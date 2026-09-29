import { message } from '../content.greeting';

export default function Page() {
	return (
		<main>
			<article>
				<p className="eyebrow">Next.js compatibility fixture</p>
				<h1>Full Node.js runtime</h1>
				<code id="result">{message}</code>
			</article>
		</main>
	);
}
