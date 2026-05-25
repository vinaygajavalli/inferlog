import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@inferlog/logger"],
  experimental: {
    // trace from the monorepo root so the standalone bundle includes the SDK
    outputFileTracingRoot: path.join(__dirname, "../../"),
    // pg and the SDK must stay server-side, never bundled for the browser
    serverComponentsExternalPackages: ["pg", "gpt-tokenizer"],
  },
};

export default nextConfig;
