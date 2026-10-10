import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pg",
    "music-metadata",
    "yauzl",
  ],
};

export default config;
