/**
 * Copy the ffmpeg binary from ffmpeg-static into apps/web/bin/ffmpeg.
 * This produces a real file (not a pnpm symlink) so Next.js file tracing
 * includes it in the serverless bundle automatically.
 */
import { copyFileSync, mkdirSync, existsSync, realpathSync } from "fs";
import { resolve, dirname } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkgIndex = require.resolve("ffmpeg-static");
const binDir = resolve(dirname(pkgIndex));
const src = realpathSync(resolve(binDir, "ffmpeg"));
const dest = resolve(dirname(import.meta.url.replace("file://", "")), "..", "bin", "ffmpeg");

mkdirSync(dirname(dest), { recursive: true });
if (existsSync(dest)) {
  console.log("[copy-ffmpeg] bin/ffmpeg already exists, skipping.");
} else {
  copyFileSync(src, dest);
  console.log(`[copy-ffmpeg] copied ${src} → ${dest}`);
}
