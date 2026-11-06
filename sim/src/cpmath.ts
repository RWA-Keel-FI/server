import type { Side } from './venue.ts'

/**
 * Arbitrage sizing against a constant-liquidity pool in human units.
 * x = L / sqrt(P) stock, y = L * sqrt(P) USD, fee taken from the input.
 */
export interface ArbPlan {
  side: Side
  /** input amount, human units of the input token (stock for sellStock, USD for buyStock) */
  grossIn: number
  /** expected profit in USD at the reference price, before gas */
  profit: number
  pTarget: number
}

/** maxMove caps how far one swap may move the pool price (fraction), so a swap does not run past an LP range edge. */
export function planArb(L: number, p: number, r: number, f: number, maxMove = 1): ArbPlan | null {
  if (!(L > 0) || !(p > 0) || !(r > 0)) return null
  const s0 = Math.sqrt(p)
  if (p > r) {
    // pool prices the stock too high: sell stock into it until the post-fee marginal price falls to r
    let pTarget = r / (1 - f)
    if (p <= pTarget) return null
    pTarget = Math.max(pTarget, p * (1 - maxMove))
    const s1 = Math.sqrt(pTarget)
    const net = L * (1 / s1 - 1 / s0)
    const grossIn = net / (1 - f)
    const usdOut = L * (s0 - s1)
    return { side: 'sellStock', grossIn, profit: usdOut - r * grossIn, pTarget }
  }
  let pTarget = r * (1 - f)
  if (p >= pTarget) return null
  pTarget = Math.min(pTarget, p * (1 + maxMove))
  const s1 = Math.sqrt(pTarget)
  const net = L * (s1 - s0)
  const grossIn = net / (1 - f)
  const stockOut = L * (1 / s0 - 1 / s1)
  return { side: 'buyStock', grossIn, profit: r * stockOut - grossIn, pTarget }
}
