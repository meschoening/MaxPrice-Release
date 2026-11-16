// Largest-remainder apportionment of a displayed money total across parts
// (#637's split money tiles). The tile's number is the authoritative exact
// total, shown in whole cents; each part has its own exact (unrounded) dollar
// value. Rounding each part on its own can leave the parts summing a cent or
// more away from the tile (n parts can drift by up to n × ½¢), so the
// displayed parts are apportioned instead:
//
// 1. every part starts at its exact value floored to the cent;
// 2. the cents still owed to reach the displayed total go one each to the
//    parts with the largest remainders, ties to the earlier part;
// 3. should the floors already exceed the total (the parts' exact sum can sit
//    a float hair across a cent boundary from the tile's own exact total),
//    cents are taken one each from the parts with the smallest remainders,
//    ties to the later part, never below zero.
//
// So the result always sums to `totalCents` exactly, every entry is a
// non-negative integer, and each is within a cent of its own exact value
// whenever the parts' exact sum rounds to within a cent of the total, which a
// split of the tile's own rows always does. Pure and deterministic: the same
// inputs in the same order give the same cents.

// The cents a money figure shows: the dollars as `toFixed(2)` prints them,
// so a total read here is the one the tile displays to the cent.
export function displayedCents(usd: number): number {
  return Math.round(Number(usd.toFixed(2)) * 100);
}

export function apportionCents(totalCents: number, exactUsd: readonly number[]): number[] {
  const n = exactUsd.length;
  if (n === 0) return [];
  const target = Math.max(0, Math.round(totalCents));
  // A negative exact value is no money: it takes nothing and gives nothing.
  const scaled = exactUsd.map((usd) => Math.max(0, Number.isFinite(usd) ? usd * 100 : 0));
  const cents = scaled.map((c) => Math.floor(c));
  const remainder = scaled.map((c, i) => c - cents[i]!);
  let owed = target - cents.reduce((s, c) => s + c, 0);

  if (owed > 0) {
    // Largest remainder first; ties to the earlier part. Cycles only in the
    // degenerate case of more cents owed than parts.
    const order = [...cents.keys()].sort((a, b) => remainder[b]! - remainder[a]! || a - b);
    for (let k = 0; owed > 0; k = (k + 1) % n, owed--) cents[order[k]!]! += 1;
  } else if (owed < 0) {
    // Smallest remainder first; ties to the later part; never below zero.
    const order = [...cents.keys()].sort((a, b) => remainder[a]! - remainder[b]! || b - a);
    while (owed < 0) {
      let took = false;
      for (const i of order) {
        if (owed === 0) break;
        if (cents[i]! > 0) {
          cents[i]! -= 1;
          owed++;
          took = true;
        }
      }
      if (!took) break;
    }
  }
  return cents;
}
