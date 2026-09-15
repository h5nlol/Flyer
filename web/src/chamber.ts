/**
 * The test chamber: bounds, and the scale everything fly-sized lives at.
 *
 * The fly model is ~9.6 x 10.6 units; the chamber floor is ~3.3 x 3.3. The model
 * is shown at FLY_SCALE, so every length defined relative to the fly (prop sizes,
 * sensing radii, camera distances) is multiplied by the same factor. The server
 * applies the same constant to body speed and ranges (see server.py).
 *
 * Bounds are fetched from chamber_bounds.json once; the numbers below are that
 * file's contents and are used until (or unless) the fetch succeeds.
 */
export const FLY_SCALE = 0.075

export type Bounds = {
  walkable: { minX: number; maxX: number; minZ: number; maxZ: number; floorY: number }
  cameraBox: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number }
}

export const chamber: Bounds = {
  walkable: { minX: -1.7269, maxX: 1.5707, minZ: -1.62, maxZ: 1.6776, floorY: 0.0518 },
  cameraBox: { minX: -1.7679, maxX: 1.6116, minZ: -1.6419, maxZ: 1.7186, minY: 0.1118, maxY: 4.1228 },
}

export const FLOOR_Y = chamber.walkable.floorY

let loading: Promise<void> | null = null

/** Replace the defaults with chamber_bounds.json, in place. Safe to call repeatedly. */
export function loadChamberBounds(): Promise<void> {
  loading ??= fetch('/models/chamber_bounds.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j: Partial<Bounds>) => {
      const ok = (o: object | undefined, keys: string[]) =>
        !!o && keys.every((k) => Number.isFinite((o as Record<string, unknown>)[k]))
      if (ok(j.walkable, ['minX', 'maxX', 'minZ', 'maxZ', 'floorY'])) Object.assign(chamber.walkable, j.walkable)
      if (ok(j.cameraBox, ['minX', 'maxX', 'minZ', 'maxZ', 'minY', 'maxY'])) Object.assign(chamber.cameraBox, j.cameraBox)
    })
    .catch((err) => console.warn('chamber_bounds.json not loaded, using built-in bounds:', err))
  return loading
}
