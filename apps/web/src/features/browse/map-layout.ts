export interface MapPoint { readonly x: number; readonly y: number; }
/** Node top-left coordinates in world space. */
export type MapPositions = Readonly<Record<string, MapPoint>>;
/** screenPoint = worldPoint * scale + {x,y}; translation is measured in viewport pixels. */
export interface MapCamera extends MapPoint { readonly scale: number; }
export interface MapGeometry {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly gap: number;
}
export interface MapViewport { readonly width: number; readonly height: number; }
export const browseMapGeometry: MapGeometry = Object.freeze({ nodeWidth: 208, nodeHeight: 104, gap: 72 });

/** Seed an absent anchor at the origin; allocate missing IDs without moving or mutating existing positions. */
export function placeMapNodes(
  existing: MapPositions, anchorId: string, ids: readonly string[], geometry: MapGeometry,
): MapPositions {
  validateGeometry(geometry);
  const positions: Record<string, MapPoint> = Object.fromEntries(Object.entries(existing));
  if (!Object.hasOwn(positions, anchorId)) Object.defineProperty(positions, anchorId, { value: { x: 0, y: 0 }, enumerable: true, configurable: true, writable: true });
  const anchor = positions[anchorId];
  if (!anchor) throw new Error("Map anchor missing");
  const buckets = new Map<string, MapPoint[]>();
  const cellWidth = geometry.nodeWidth + geometry.gap, cellHeight = geometry.nodeHeight + geometry.gap;
  const occupy = (point: MapPoint) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Invalid map position");
    const key = `${Math.floor(point.x / cellWidth)},${Math.floor(point.y / cellHeight)}`;
    const points = buckets.get(key) ?? []; points.push(point); buckets.set(key, points);
  };
  for (const point of Object.values(positions)) occupy(point);
  const available = (point: MapPoint) => {
    const cx = Math.floor(point.x / cellWidth), cy = Math.floor(point.y / cellHeight);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      if ((buckets.get(`${x},${y}`) ?? []).some(other => Math.abs(other.x - point.x) < cellWidth && Math.abs(other.y - point.y) < cellHeight)) return false;
    }
    return true;
  };
  for (const id of ids) {
    if (Object.hasOwn(positions, id)) continue;
    let placed: MapPoint | null = null;
    for (let radius = 1; placed === null; radius++) {
      // A clockwise square ring, beginning to the right of the expanded thought.
      const cells: MapPoint[] = [{ x: radius, y: 0 }];
      for (let y = 1; y <= radius; y++) cells.push({ x: radius, y });
      for (let x = radius - 1; x >= -radius; x--) cells.push({ x, y: radius });
      for (let y = radius - 1; y >= -radius; y--) cells.push({ x: -radius, y });
      for (let x = -radius + 1; x <= radius; x++) cells.push({ x, y: -radius });
      for (let y = -radius + 1; y < 0; y++) cells.push({ x: radius, y });
      for (const cell of cells) {
        const candidate = { x: anchor.x + cell.x * (geometry.nodeWidth + geometry.gap), y: anchor.y + cell.y * (geometry.nodeHeight + geometry.gap) };
        if (available(candidate)) { placed = candidate; break; }
      }
    }
    Object.defineProperty(positions, id, { value: placed, enumerable: true, configurable: true, writable: true });
    occupy(placed);
  }
  return positions;
}

/** Explicit Fit map, using supplied dimensions and bounds rather than a hidden production viewport. */
export function fitMapCamera(
  positions: MapPositions,
  geometry: MapGeometry,
  viewport: MapViewport,
  options: { readonly padding: number; readonly minScale: number; readonly maxScale: number },
): MapCamera {
  validateGeometry(geometry);
  if (![viewport.width, viewport.height, options.minScale, options.maxScale].every(value => Number.isFinite(value) && value > 0)
      || !Number.isFinite(options.padding) || options.padding < 0 || options.maxScale < options.minScale) throw new Error("Invalid map viewport");
  const points = Object.values(positions);
  if (!points.length) return { x: viewport.width / 2, y: viewport.height / 2, scale: Math.max(options.minScale, Math.min(options.maxScale, 1)) };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Invalid map position");
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + geometry.nodeWidth); maxY = Math.max(maxY, point.y + geometry.nodeHeight);
  }
  const scale = Math.max(options.minScale, Math.min(options.maxScale,
    Math.max(1, viewport.width - 2 * options.padding) / (maxX - minX), Math.max(1, viewport.height - 2 * options.padding) / (maxY - minY)));
  return { scale, x: (viewport.width - (maxX - minX) * scale) / 2 - minX * scale,
    y: (viewport.height - (maxY - minY) * scale) / 2 - minY * scale };
}

function validateGeometry(geometry: MapGeometry) {
  if (![geometry.nodeWidth, geometry.nodeHeight].every(value => Number.isFinite(value) && value > 0)
      || !Number.isFinite(geometry.gap) || geometry.gap < 0) throw new Error("Invalid map geometry");
}
