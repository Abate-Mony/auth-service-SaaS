// utils/routeOptimizer.ts
//
// Orders a worker's stops for the day into a short route, using straight-line
// (haversine) distance only — no Google/Mapbox routing API call, so this has
// zero marginal cost per request. It won't account for actual roads, one-way
// streets or traffic, so the resulting order is an approximation, not a
// true shortest-road-path route — good enough to turn "visit these 5 sites
// in whatever order they were scheduled" into "visit them roughly
// nearest-to-nearest" without paying for a routing API on every request.
//
// Algorithm: nearest-neighbor from a start point (or from the first stop if
// no start is given) — at each step, jump to whichever remaining stop is
// closest to the current position. This is a classic, cheap TSP
// approximation: not optimal, but fast (O(n^2), fine for a single worker's
// day — a handful of stops) and never produces a wildly bad route in
// practice for small stop counts.

export interface RouteStop {
  id: string;
  lat: number;
  lng: number;
}

export interface OrderedRouteStop extends RouteStop {
  /** 0-indexed position in the optimized visiting order. */
  order: number;
  /** Straight-line distance in km from the previous stop (0 for the first). */
  distanceFromPreviousKm: number;
}

export interface OptimizedRoute {
  stops: OrderedRouteStop[];
  totalDistanceKm: number;
}

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export const haversineDistanceKm = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
};

// `start` is typically the worker's current GPS position (if the app sends
// it) — falling back to the first stop in `stops` (e.g. whichever job is
// scheduled earliest) keeps the function usable even when no live location
// is available.
export const optimizeRoute = (
  stops: RouteStop[],
  start?: { lat: number; lng: number }
): OptimizedRoute => {
  if (stops.length === 0) return { stops: [], totalDistanceKm: 0 };

  const remaining = [...stops];
  const ordered: OrderedRouteStop[] = [];

  let current = start ?? remaining[0];
  let totalDistanceKm = 0;

  // If no explicit start was given, the first stop itself is the starting
  // point (distance 0), not a destination to route to.
  if (!start) {
    const first = remaining.shift()!;
    ordered.push({ ...first, order: 0, distanceFromPreviousKm: 0 });
    current = first;
  }

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistanceKm = haversineDistanceKm(current, remaining[0]);

    for (let i = 1; i < remaining.length; i++) {
      const distanceKm = haversineDistanceKm(current, remaining[i]);
      if (distanceKm < nearestDistanceKm) {
        nearestDistanceKm = distanceKm;
        nearestIndex = i;
      }
    }

    const [next] = remaining.splice(nearestIndex, 1);
    totalDistanceKm += nearestDistanceKm;
    ordered.push({ ...next, order: ordered.length, distanceFromPreviousKm: nearestDistanceKm });
    current = next;
  }

  return { stops: ordered, totalDistanceKm: Math.round(totalDistanceKm * 10) / 10 };
};
