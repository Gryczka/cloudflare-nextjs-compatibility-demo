import type { NextConfig } from 'next';

const previewBasePath = process.env.COMPATIBILITY_ASSET_PREFIX;
const nextConfig: NextConfig = {
	...(process.env.COMPATIBILITY_CONTAINER_BUILD === '1' ? { output: 'standalone' as const } : {}),
	...(previewBasePath ? { assetPrefix: previewBasePath, basePath: previewBasePath } : {}),
	turbopack: {
		rules: {
			'*.greeting': {
				loaders: ['./greeting-loader.cjs'],
				as: '*.js',
			},
		},
	},
};

export default nextConfig;
