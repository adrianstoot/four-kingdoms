export interface TerrainImageDimensions {
  width: number;
  height: number;
}

function positiveDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Ensures the decoded terrain source has usable dimensions and still matches
 * the square UV layout used by the illustrated board.
 */
export function validateTerrainImage(source: unknown): TerrainImageDimensions {
  if (!source || typeof source !== "object") {
    throw new Error("terrain-map.png did not decode to an image.");
  }

  const image = source as Record<string, unknown>;
  const width = positiveDimension(image.naturalWidth)
    ?? positiveDimension(image.videoWidth)
    ?? positiveDimension(image.width);
  const height = positiveDimension(image.naturalHeight)
    ?? positiveDimension(image.videoHeight)
    ?? positiveDimension(image.height);

  if (width === null || height === null) {
    throw new Error("terrain-map.png has invalid decoded dimensions.");
  }
  if (width < 512 || height < 512) {
    throw new Error(`terrain-map.png is too small (${width}x${height}); expected at least 512x512.`);
  }
  if (Math.abs(width / height - 1) > 0.02) {
    throw new Error(`terrain-map.png must be square, but decoded as ${width}x${height}.`);
  }

  return { width, height };
}
