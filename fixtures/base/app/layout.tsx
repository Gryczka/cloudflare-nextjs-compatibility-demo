import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
	title: 'Next.js compatibility fixture',
	description: 'A controlled Next.js compatibility target',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
