/**
 * Query helper: fetch and downsample historical data for a single tag.
 *
 * Steps:
 *  1. Look-back: find the last recorded value BEFORE the query window so the
 *     left edge renders a flat step rather than an empty gap.
 *  2. Range scan: iterate all points within [startTs, endTs].
 *  3. LTTB downsample if the result exceeds maxPoints (default 2000).
 */

import type { HistorianDB, HistoryPoint } from './db';

const DEFAULT_MAX_POINTS = 2000;

export async function queryTag(
  db: HistorianDB,
  tagId: number,
  startTs: number,
  endTs: number,
  maxPoints: number = DEFAULT_MAX_POINTS,
): Promise<HistoryPoint[]> {
  const points: HistoryPoint[] = [];

  // Look-back: prepend last known value before the window as a synthetic
  // first point at startTs so step-hold lines render from the left edge.
  const prior = await db.lookBack(tagId, startTs);
  if (prior !== null) {
    points.push({ ts: startTs, value: prior.value });
  }

  // Range scan
  for await (const pt of db.rangeScan(tagId, startTs, endTs)) {
    // Avoid a duplicate at startTs if the lookBack happened to land exactly there
    if (points.length > 0 && pt.ts === points[0]!.ts) {
      points[0]!.value = pt.value;
    } else {
      points.push(pt);
    }
  }

  if (points.length <= maxPoints) return points;

  // LTTB downsample — only numeric values are supported; coerce null/bool
  // to 0 for the purposes of the algorithm (shape is still preserved).
  return lttb(points, maxPoints);
}

/**
 * Largest-Triangle-Three-Buckets downsampling.
 * Preserves visual shape while reducing point count.
 * https://github.com/sveinn-steinarsson/flot-downsample
 */
function lttb(data: HistoryPoint[], threshold: number): HistoryPoint[] {
  const n = data.length;
  if (threshold >= n || threshold < 2) return data;

  const sampled: HistoryPoint[] = [];
  let sampledIdx = 0;

  // Always include first point
  sampled.push(data[0]!);
  sampledIdx++;

  const bucketSize = (n - 2) / (threshold - 2);

  let a = 0; // previously selected point index

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate next bucket range
    const nextBucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    // Average of next bucket (for area calculation)
    let avgX = 0;
    let avgY = 0;
    const avgRangeLength = nextBucketEnd - nextBucketStart;
    for (let j = nextBucketStart; j < nextBucketEnd; j++) {
      avgX += data[j]!.ts;
      avgY += toNumber(data[j]!.value);
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    // Current bucket range
    const bucketStart = Math.floor(i * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, n);

    const pointAX = data[a]!.ts;
    const pointAY = toNumber(data[a]!.value);

    let maxArea = -1;
    let maxAreaIdx = bucketStart;

    for (let j = bucketStart; j < bucketEnd; j++) {
      // Calculate triangle area (times 2 to avoid /2)
      const area = Math.abs(
        (pointAX - avgX) * (toNumber(data[j]!.value) - pointAY) -
        (pointAX - data[j]!.ts) * (avgY - pointAY),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIdx = j;
      }
    }

    sampled.push(data[maxAreaIdx]!);
    a = maxAreaIdx;
  }

  // Always include last point
  sampled.push(data[n - 1]!);
  return sampled;
}

function toNumber(v: number | boolean | null): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
