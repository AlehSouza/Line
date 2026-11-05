import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Exporta HTML/JS estático em out/, que o Electron serve pelo protocolo app://
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@line/shared'],
  reactStrictMode: true,
};

export default nextConfig;
