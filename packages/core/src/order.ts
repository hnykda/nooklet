import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Order key strictly between a and b (either may be null for open ends). */
export function orderBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b);
}

/** n order keys strictly between a and b, ascending. */
export function ordersBetween(a: string | null, b: string | null, n: number): string[] {
  return generateNKeysBetween(a, b, n);
}

export function compareOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
