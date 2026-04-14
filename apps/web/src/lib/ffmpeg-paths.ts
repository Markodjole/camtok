import { chmodSync, existsSync } from "fs";
import ffmpegBinary from "ffmpeg-static";
import { path as ffprobeStaticPath } from "ffprobe-static";

/**
 * Bundled ffmpeg/ffprobe (linux x64 on Vercel). Static imports + `outputFileTracingIncludes`
 * ensure Vercel copies the binaries into the serverless bundle (dynamic `require` is not traced).
 *
 * Overrides (optional):
 * - FFMPEG_BIN — full path to ffmpeg
 * - FFPROBE_BIN / FFPROBE_PATH — full path to ffprobe
 *
 * Binaries may lose the executable bit in the deploy archive; we chmod once before first exec.
 */

const chmodOnce = new Set<string>();

function ensureExecutable(binPath: string) {
  if (binPath === "ffmpeg" || binPath === "ffprobe") return;
  if (chmodOnce.has(binPath)) return;
  chmodOnce.add(binPath);
  try {
    chmodSync(binPath, 0o755);
  } catch {
    /* ignore */
  }
}

function bundledFfmpegPath(): string | null {
  const env = process.env.FFMPEG_BIN?.trim();
  if (env && existsSync(env)) {
    ensureExecutable(env);
    return env;
  }
  if (typeof ffmpegBinary === "string" && ffmpegBinary.length > 0 && existsSync(ffmpegBinary)) {
    ensureExecutable(ffmpegBinary);
    return ffmpegBinary;
  }
  return null;
}

function bundledFfprobePath(): string | null {
  const env = process.env.FFPROBE_BIN?.trim() || process.env.FFPROBE_PATH?.trim();
  if (env && existsSync(env)) {
    ensureExecutable(env);
    return env;
  }
  if (typeof ffprobeStaticPath === "string" && ffprobeStaticPath.length > 0 && existsSync(ffprobeStaticPath)) {
    ensureExecutable(ffprobeStaticPath);
    return ffprobeStaticPath;
  }
  return null;
}

let ffmpegResolved: string | undefined;
let ffprobeResolved: string | undefined;

export function getFfmpegBinaryPath(): string {
  if (ffmpegResolved) return ffmpegResolved;
  ffmpegResolved = bundledFfmpegPath() || "ffmpeg";
  return ffmpegResolved;
}

export function getFfprobeBinaryPath(): string {
  if (ffprobeResolved) return ffprobeResolved;
  ffprobeResolved = bundledFfprobePath() || "ffprobe";
  return ffprobeResolved;
}
