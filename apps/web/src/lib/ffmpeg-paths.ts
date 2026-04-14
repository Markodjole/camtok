import { chmodSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";

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

  const candidates = [
    join(process.cwd(), "bin", "ffmpeg"),
    join(process.cwd(), ".next", "server", "bin", "ffmpeg"),
    resolve(__dirname, "..", "..", "bin", "ffmpeg"),
    resolve(__dirname, "..", "..", "..", "bin", "ffmpeg"),
    resolve(__dirname, "..", "..", "..", "..", "bin", "ffmpeg"),
    "/var/task/bin/ffmpeg",
    "/var/task/.next/standalone/bin/ffmpeg",
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      ensureExecutable(p);
      console.log(`[ffmpeg-paths] found binary at: ${p}`);
      return p;
    }
  }

  console.error(
    `[ffmpeg-paths] binary not found. cwd=${process.cwd()} __dirname=${__dirname} candidates=${JSON.stringify(candidates)}`,
  );
  try {
    console.error(`[ffmpeg-paths] cwd listing: ${readdirSync(process.cwd()).join(", ")}`);
    const binDir = join(process.cwd(), "bin");
    if (existsSync(binDir)) {
      console.error(`[ffmpeg-paths] bin/ listing: ${readdirSync(binDir).join(", ")}`);
    }
  } catch {
    /* ignore */
  }

  return "ffmpeg";
}

let resolved: string | undefined;

export function getFfmpegBinaryPath(): string {
  if (resolved) return resolved;
  resolved = findFfmpeg();
  return resolved;
}
