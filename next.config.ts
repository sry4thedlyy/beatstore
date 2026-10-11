import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: { "/*": ["./assets/fonts/*.ttf"] },
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pg",
    "music-metadata",
    "yauzl",
  ],
};

export default config;
