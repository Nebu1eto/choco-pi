export function computeTotal(prices: readonly number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
