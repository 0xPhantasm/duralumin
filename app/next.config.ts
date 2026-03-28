import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.app.github.dev"],

  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: require.resolve("crypto-browserify"),
        stream: require.resolve("stream-browserify"),
        buffer: require.resolve("buffer/"),
        process: require.resolve("process/browser"),
        fs: false,
        net: false,
        tls: false,
        os: false,
        path: false,
      };
    }
    return config;
  },

  turbopack: {
    resolveAlias: {
      fs: { browser: "./empty-module.js" },
    },
  },
};

export default nextConfig;
