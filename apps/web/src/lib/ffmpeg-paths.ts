import { chmodSync, existsSync } from "fs";
import { join } from "path";

/**
 * Resolve the ffmpeg binary at runtime.
 *
 * Priority:
 *  1. FFMPEG_BIN env var
 *  2. apps/web/bin/ffmpeg  (copied at build time by scripts/copy-ffmpeg.mjs — real file, no symlink)
 *  3. ffmpeg on PATH (local dev fallback)
 */

const chmodOnce = new Set<string>();

function ensureExecutable(binPath: string) {
  if (binPath === "ffmpeg") return;
  if (chmodOnce.has(binPath)) return;
  chmodOnce.add(binPath);
  try {
    chmodSync(binPath, 0o755);
  } catch {
    /* ignore */
  }
}

function findFfmpeg(): string {
  const env = process.env.FFMPEG_BIN?.trim();
  if (env && existsSync(env)) {
    ensureExecutable(env);
    return env;
  }

  // Built by scripts/copy-ffmpeg.mjs → real file in the project, auto-traced by Next.js NFT.
  const local = join(process.cwd(), "bin", "ffmpeg");
  if (existsSync(local)) {
    ensureExecutable(local);
    return local;
  }

  return "ffmpeg";
}

let resolved: string | undefined;

export function getFfmpegBinaryPath(): string {
  if (resolved) return resolved;
  resolved = findFfmpeg();
  return resolved;
}
