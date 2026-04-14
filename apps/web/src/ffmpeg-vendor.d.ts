declare module "ffmpeg-static" {
  const binaryPath: string | null;
  export default binaryPath;
}

declare module "ffprobe-static" {
  export const path: string;
}
