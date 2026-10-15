import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API-only backend: no image optimisation, no powered-by header.
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
