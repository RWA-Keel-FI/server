import type { Side } from './venue.ts'

/** Floating-point mirror of the hook's fee rule (docs/ARCHITECTURE.md section 1). The contract uses integer math. */
export interface FeeParams {
  /** base fee, fraction (0.003 = 30 bps) */
  f0: number
  feeMax: number
  /** stock volatility, fraction per root second */
  sigma: number
  maxAge: number
}

export interface FeeResult {
  fee: number
  d: number
  dEff: number
  armed: boolean
}

/** A swap is in the arbitrage direction when it pushes the pool price toward the reference. */
export function isArbDirection(poolPrice: number, refPrice: number, side: Side): boolean {
  return poolPrice > refPrice ? side === 'sellStock' : side === 'buyStock'
}

export function hookFee(p: FeeParams, poolPrice: number, refPrice: number, ageSec: number, sessionOpen: boolean, side: Side): FeeResult {
  if (!sessionOpen || refPrice <= 0 || ageSec > p.maxAge || ageSec < 0) return { fee: p.f0, d: 0, dEff: 0, armed: false }
  const d = Math.abs(poolPrice / refPrice - 1)
  const dEff = Math.max(0, d - p.sigma * Math.sqrt(Math.max(ageSec, 1)))
  if (!isArbDirection(poolPrice, refPrice, side)) return { fee: p.f0, d, dEff, armed: false }
  const fee = Math.min(p.feeMax, Math.max(p.f0, dEff / 2))
  return { fee, d, dEff, armed: fee > p.f0 }
}
