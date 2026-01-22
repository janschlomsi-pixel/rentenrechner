import type { NextConfig } from "next";

const repo = "rentenrechner";

const nextConfig: NextConfig = {
  output: "export",
  basePath: `/${repo}`,
  assetPrefix: `/${repo}/`,
  images: { unoptimized: true },
};

export default nextConfig;

