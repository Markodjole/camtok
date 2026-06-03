/**
 * Map elapsed seconds to under / at / over option ids.
 * Labels are "< T sec", "= T sec", "> T sec" — buckets must match literally.
 */
export function classifyEstimatedTimeOption(
  elapsedSec: number,
  estimatedSec: number,
  prefix: "exit" | "step",
): `${typeof prefix}_under` | `${typeof prefix}_at` | `${typeof prefix}_over` {
  const elapsed = Math.round(elapsedSec);
  const T = Math.round(estimatedSec);
  if (elapsed < T) return `${prefix}_under`;
  if (elapsed > T) return `${prefix}_over`;
  return `${prefix}_at`;
}
