import type { NextConfig } from 'next';

const previewBasePath = process.env.COMPATIBILITY_ASSET_PREFIX;
const nextConfig: NextConfig = {
	...(process.env.COMPATIBILITY_CONTAINER_BUILD === '1' ? { output: 'standalone' as const } : {}),
	...(previewBasePath ? { assetPrefix: previewBasePath, basePath: previewBasePath } : {}),
};

export default nextConfig;
