import { fal } from "@fal-ai/client";

let configured = false;

export function getFalClient() {
  if (!configured) {
    const key = process.env.FAL_KEY;
    if (!key) {
      throw new Error("Missing FAL_KEY env var");
    }
    fal.config({ credentials: key });
    configured = true;
  }
  return fal;
}

