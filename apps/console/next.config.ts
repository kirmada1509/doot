import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@doot/core", "@doot/contracts"],
  devIndicators: false
};

export default nextConfig;
