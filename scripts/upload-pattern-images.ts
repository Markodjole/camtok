/**
 * Upload pattern images to Supabase storage.
 *
 * Usage:
 *   npx tsx scripts/upload-pattern-images.ts
 *
 * Before running, place these files in scripts/pattern-images/:
 *   lion_grass.jpg
 *   vending_machine.jpg
 *   beetle_red_light.jpg
 *   woman_two_outfits.jpg
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PATTERNS = [
  { slug: "lion_grass", file: "lion_grass.jpg", storagePath: "patterns/lion_grass.png" },
  { slug: "vending_machine", file: "vending_machine.jpg", storagePath: "patterns/vending_machine.png" },
  { slug: "beetle_red_light", file: "beetle_red_light.jpg", storagePath: "patterns/beetle_red_light.png" },
  { slug: "woman_two_outfits", file: "woman_two_outfits.jpg", storagePath: "patterns/woman_two_outfits.png" },
];

async function main() {
  const dir = path.join(__dirname, "pattern-images");

  for (const p of PATTERNS) {
    const filePath = path.join(dir, p.file);
    if (!fs.existsSync(filePath)) {
      console.log(`⚠ Skipping ${p.slug}: ${filePath} not found`);
      continue;
    }

    const bytes = fs.readFileSync(filePath);
    const { error } = await supabase.storage
      .from("media")
      .upload(p.storagePath, bytes, { upsert: true, contentType: "image/jpeg" });

    if (error) {
      console.error(`✗ ${p.slug}: ${error.message}`);
    } else {
      console.log(`✓ ${p.slug} → ${p.storagePath}`);
    }
  }

  console.log("\nDone. Pattern images uploaded to media bucket.");
}

main();
