/**
 * Bundle + minify src/index.mjs into dist/index.mjs with the package
 * version baked in so backend's X-Client-Version gate accepts us.
 *
 * Codex-shell talks to backend over WS only — no HTTP fetches, so no
 * HMAC secret is required (the WS handshake auth is the agent_token).
 */
import { build } from "esbuild";
import { readFileSync, rmSync } from "fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ["src/index.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.mjs",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    "process.env.INBETWEEN_CLIENT_VERSION": JSON.stringify(pkg.version),
  },
  external: ["ws"],
});

console.log(`✓ built dist/index.mjs (v${pkg.version})`);
