// utils/geo.ts

/** Great-circle distance between two points, in metres. */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000; // Earth radius, metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export interface GeofenceCheck {
  distanceMeters: number | null;
  withinRadius: boolean;
  flagged: boolean;
  /** True when the reading is too imprecise to judge either way. */
  inconclusive: boolean;
}

export function checkGeofence({
  jobCoords,
  workerCoords,
  radiusMeters,
}: {
  jobCoords?: { lat?: number; lng?: number } | null;
  workerCoords?: { lat: number; lng: number; accuracy?: number } | null;
  radiusMeters: number;
}): GeofenceCheck {
  // No site coordinates, or the worker sent none — nothing to compare
  if (!jobCoords?.lat || !jobCoords?.lng || !workerCoords) {
    return { distanceMeters: null, withinRadius: true, flagged: false, inconclusive: true };
  }

  const distance = distanceMeters(
    { lat: jobCoords.lat, lng: jobCoords.lng },
    workerCoords
  );

  // A reading 400m out with 500m accuracy tells you nothing. Widen the
  // allowed radius by the device's own margin of error before judging.
  const accuracy = workerCoords.accuracy ?? 0;
  const effectiveRadius = radiusMeters + Math.min(accuracy, 500);
  const withinRadius = distance <= effectiveRadius;

  return {
    distanceMeters: distance,
    withinRadius,
    flagged: !withinRadius,
    inconclusive: accuracy > 500,
  };
}