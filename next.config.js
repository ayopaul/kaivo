/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['pdfjs-dist'],
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, canvas: false };
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  },
};

module.exports = nextConfig;
