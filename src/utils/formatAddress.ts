// Turns a Client's structured address (line1/line2/city/county/postcode/
// country — all optional) into the single display string the frontend
// actually renders (`client.formattedAddress`). Computed here, once, rather
// than in each of the several places a Client gets serialized, so every
// client-returning endpoint stays in sync automatically.
export interface AddressLike {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
  country?: string | null;
}

export const formatAddress = (address?: AddressLike | null): string | undefined => {
  if (!address) return undefined;
  const parts = [address.line1, address.line2, address.city, address.county, address.postcode, address.country].filter(
    (p): p is string => !!p && p.trim().length > 0
  );
  return parts.length ? parts.join(", ") : undefined;
};
