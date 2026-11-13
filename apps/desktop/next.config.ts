import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Exporta HTML/JS estático em out/, que o Tauri empacota e serve dentro do app
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@line/shared'],
  reactStrictMode: true,
};

export default nextConfig;
