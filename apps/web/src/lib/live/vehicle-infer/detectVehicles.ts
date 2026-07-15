import type { ServerVehicleDetection } from "./serverRoundCounter";

const VEHICLE_CLASSES = new Set([
  "car",
  "motorcycle",
  "bus",
  "truck",
  "bicycle",
  "vehicle",
]);

export type DetectedVehicle = ServerVehicleDetection;

function normalizeBox(
  x: number,
  y: number,
  width: number,
  height: number,
  imgW: number,
  imgH: number,
): { x: number; y: number; width: number; height: number } {
  const w = Math.max(0, Math.min(1, width / imgW));
  const h = Math.max(0, Math.min(1, height / imgH));
  const left = Math.max(0, Math.min(1 - w, (x - width / 2) / imgW));
  const top = Math.max(0, Math.min(1 - h, (y - height / 2) / imgH));
  return { x: left, y: top, width: w, height: h };
}

async function detectWithRoboflow(
  imageBase64: string,
  apiKey: string,
): Promise<DetectedVehicle[]> {
  const model = process.env.ROBOFLOW_VEHICLE_MODEL ?? "coco/3";
  const res = await fetch(
    `https://detect.roboflow.com/${model}?api_key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: imageBase64,
    },
  );
  if (!res.ok) {
    throw new Error(`roboflow_${res.status}`);
  }
  const json = (await res.json()) as {
    image?: { width?: number; height?: number };
    predictions?: Array<{
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      class?: string;
      confidence?: number;
    }>;
  };
  const imgW = json.image?.width ?? 320;
  const imgH = json.image?.height ?? 320;
  const out: DetectedVehicle[] = [];
  for (const p of json.predictions ?? []) {
    const cls = (p.class ?? "").toLowerCase();
    if (!VEHICLE_CLASSES.has(cls)) continue;
    const conf = p.confidence ?? 0;
    if (conf < 0.35) continue;
    if (
      p.x == null ||
      p.y == null ||
      p.width == null ||
      p.height == null
    ) {
      continue;
    }
    out.push({
      vehicleType: "vehicle",
      confidence: conf,
      boundingBox: normalizeBox(p.x, p.y, p.width, p.height, imgW, imgH),
    });
  }
  return out;
}

async function detectWithOpenAi(
  imageBase64: string,
  apiKey: string,
): Promise<DetectedVehicle[]> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: process.env.VEHICLE_INFER_LLM_MODEL ?? "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "low",
            },
          },
          {
            type: "text",
            text:
              'Detect cars, trucks, buses, motorcycles in this road-camera frame. Return JSON: {"detections":[{"confidence":0.9,"boundingBox":{"x":0.1,"y":0.2,"width":0.15,"height":0.12}}]} with normalized 0-1 boxes (x,y top-left). Only real vehicles on the road.',
          },
        ],
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as {
    detections?: Array<{
      confidence?: number;
      boundingBox?: { x?: number; y?: number; width?: number; height?: number };
    }>;
  };
  return (parsed.detections ?? [])
    .filter((d) => (d.confidence ?? 0) >= 0.35)
    .map((d) => ({
      vehicleType: "vehicle" as const,
      confidence: d.confidence ?? 0.5,
      boundingBox: {
        x: d.boundingBox?.x ?? 0,
        y: d.boundingBox?.y ?? 0,
        width: d.boundingBox?.width ?? 0,
        height: d.boundingBox?.height ?? 0,
      },
    }));
}

/**
 * Server vehicle detector — Roboflow (fast) when configured, else OpenAI vision.
 */
export async function detectVehiclesFromJpeg(
  imageBase64: string,
): Promise<DetectedVehicle[]> {
  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  if (roboflowKey) {
    try {
      return await detectWithRoboflow(imageBase64, roboflowKey);
    } catch (e) {
      console.warn("[vehicle-infer] Roboflow failed", e);
    }
  }

  const llmKey = process.env.LLM_API_KEY;
  if (process.env.LLM_PROVIDER === "openai" && llmKey) {
    try {
      return await detectWithOpenAi(imageBase64, llmKey);
    } catch (e) {
      console.warn("[vehicle-infer] OpenAI vision failed", e);
    }
  }

  return [];
}
