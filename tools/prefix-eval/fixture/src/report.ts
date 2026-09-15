import { computeTotal } from "./cart.ts";

export function totalLine(prices: readonly number[]): string {
  return `Total: ${computeTotal(prices)}`;
}
