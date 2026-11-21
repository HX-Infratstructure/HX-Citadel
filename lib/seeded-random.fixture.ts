// A seeded random generator for property tests; Convex never bundles this file.

/** A small deterministic generator (mulberry32), so a failing trial can be replayed by its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T,>(next: () => number, items: T[]) => items[Math.floor(next() * items.length)];
