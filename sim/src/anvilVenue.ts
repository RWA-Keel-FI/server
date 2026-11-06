import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, encodePacked, parseAbi, parseEventLogs,
  toHex, type Address, type Hex,
} from 'viem'
import { foundry } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { TICKERS, type SimParams, type Ticker } from './config.ts'
import type { Actor, OracleView, PoolRef, PoolState, Side, SwapFill, Venue } from './venue.ts'

// anvil's well-known PUBLIC default test keys (accounts 0..9). Worthless anywhere except a local anvil.
const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
]

const KEY_TUPLE = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'
const ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  `function quoteFee(${KEY_TUPLE} key, bool zeroForOne) view returns (uint24 fee, uint256 dPips, bool arbDirection)`,
  `function swapExactIn(${KEY_TUPLE} key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut) returns (uint256 amountOut)`,
  'function priceOf(bytes32 feedId) view returns (uint64 priceE8, uint64 asOf, bool sessionOpen)',
  'function deliver(address receiver, bytes report)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])

interface PoolJson {
  poolId: Hex
  key?: { currency0: Address; currency1: Address; fee: number | string; tickSpacing: number | string; hooks: Address }
  currency0?: Address
  currency1?: Address
  fee?: number | string
  tickSpacing?: number | string
  hooks?: Address
}
interface TickerJson {
  feedId: Hex
  token: Address
  startPriceE8: number | string
  stockIsCurrency0?: boolean | string
  hookPool: PoolJson
  controlPool: PoolJson
}
export interface Deployment {
  chainId: number | string
  rpc?: string
  poolManager: Address
  oracle: Address
  hook: Address
  forwarder: Address
  usdc: Address
  issuer?: Address
  swapRouter: Address
  liquidityRouter?: Address
  accounts?: Record<string, string | { address: string }>
  tickers: Record<string, TickerJson>
}

interface PoolRt {
  ref: PoolRef
  poolId: Hex
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  stockIsC0: boolean
  token: Address
  dStock: number
  dUsd: number
}

const num = (x: number | string | undefined, d = 0) => (x === undefined ? d : Number(x))

/** Swaps and oracle reports go to the deployed PoolManager, hook, oracle and forwarder on a local anvil. */
export class AnvilVenue implements Venue {
  kind = 'anvil' as const
  private pub!: ReturnType<typeof createPublicClient>
  private test!: ReturnType<typeof createTestClient>
  private wallets = new Map<string, ReturnType<typeof createWalletClient>>()
  private pools_: PoolRt[] = []
  private starts = {} as Record<Ticker, number>
  private lastTs = 0
  private f0 = 3000

  constructor(private dep: Deployment, private params: SimParams, _deployDir?: string) {
    void _deployDir
    void this.params
  }

  private keyFor(name: string, fallbackIndex: number): Hex {
    const a = this.dep.accounts?.[name]
    const addr = (typeof a === 'string' ? a : a?.address)?.toLowerCase()
    if (addr) {
      const hit = ANVIL_KEYS.find((k) => privateKeyToAccount(k).address.toLowerCase() === addr)
      if (hit) return hit
    }
    return ANVIL_KEYS[fallbackIndex]!
  }

  async init(): Promise<void> {
    const rpc = this.dep.rpc ?? 'http://127.0.0.1:8545'
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(rpc)) throw new Error(`refusing non-local rpc ${rpc}`)
    const transport = http(rpc)
    this.pub = createPublicClient({ chain: foundry, transport })
    this.test = createTestClient({ chain: foundry, mode: 'anvil', transport })
    const chainId = await this.pub.getChainId()
    if (chainId !== 31337) throw new Error(`chain id ${chainId}: this simulator only runs on local anvil (31337)`)

    for (const [name, idx] of [['arb', 4], ['retail', 5], ['feeder', 6]] as const) {
      const account = privateKeyToAccount(this.keyFor(name, idx))
      this.wallets.set(name, createWalletClient({ account, chain: foundry, transport }))
    }

    const usdc = this.dep.usdc
    const dUsd = Number(await this.pub.readContract({ address: usdc, abi: ABI, functionName: 'decimals' }))
    for (const tk of TICKERS) {
      const t = this.dep.tickers[tk]
      if (!t) throw new Error(`deployment has no ticker ${tk}`)
      const dStock = Number(await this.pub.readContract({ address: t.token, abi: ABI, functionName: 'decimals' }))
      const stockIsC0 = t.token.toLowerCase() < usdc.toLowerCase()
      this.starts[tk] = Number(t.startPriceE8) / 1e8
      for (const kind of ['hook', 'control'] as const) {
        const pj = kind === 'hook' ? t.hookPool : t.controlPool
        const k = pj.key ?? { currency0: pj.currency0!, currency1: pj.currency1!, fee: pj.fee!, tickSpacing: pj.tickSpacing!, hooks: pj.hooks! }
        this.pools_.push({
          ref: { ticker: tk, kind, id: `${tk}-${kind}` },
          poolId: pj.poolId,
          key: { currency0: k.currency0, currency1: k.currency1, fee: num(k.fee), tickSpacing: num(k.tickSpacing), hooks: k.hooks },
          stockIsC0,
          token: t.token,
          dStock,
          dUsd,
        })
        if (kind === 'control') this.f0 = num(k.fee)
      }
    }
    // make sure the trading accounts have approved the swap router (the deploy script normally does this)
    for (const name of ['arb', 'retail'] as const) {
      const w = this.wallets.get(name)!
      const me = w.account!.address
      for (const token of [usdc, ...TICKERS.map((tk) => this.dep.tickers[tk]!.token)]) {
        const al = (await this.pub.readContract({ address: token, abi: ABI, functionName: 'allowance', args: [me, this.dep.swapRouter] })) as bigint
        if (al < 10n ** 30n) {
          const h = await w.writeContract({ address: token, abi: ABI, functionName: 'approve', args: [this.dep.swapRouter, 2n ** 256n - 1n], chain: foundry, account: w.account! })
          await this.pub.waitForTransactionReceipt({ hash: h })
        }
      }
    }
    this.lastTs = Number((await this.pub.getBlock()).timestamp)
  }

  tickers(): Ticker[] {
    return [...TICKERS]
  }
  startPriceUsd(t: Ticker): number {
    return this.starts[t]
  }
  pools(): PoolRef[] {
    return this.pools_.map((p) => p.ref)
  }
  f0Pips(): number {
    return this.f0
  }
  async nowSec(): Promise<number> {
    this.lastTs = Math.max(this.lastTs, Number((await this.pub.getBlock()).timestamp))
    return this.lastTs
  }
  async setTime(t: number): Promise<number> {
    const use = Math.max(t, (await this.nowSec()) + 1)
    await this.test.setNextBlockTimestamp({ timestamp: BigInt(use) })
    await this.test.mine({ blocks: 1 })
    this.lastTs = use
    return use
  }

  private rt(p: PoolRef): PoolRt {
    const r = this.pools_.find((x) => x.ref.id === p.id)
    if (!r) throw new Error(`unknown pool ${p.id}`)
    return r
  }
  private async slot0(r: PoolRt) {
    const base = keccak256(encodePacked(['bytes32', 'bytes32'], [r.poolId, toHex(6n, { size: 32 })]))
    const s0 = (await this.pub.readContract({ address: this.dep.poolManager, abi: ABI, functionName: 'extsload', args: [base] })) as Hex
    const liqSlot = toHex(BigInt(base) + 3n, { size: 32 })
    const l = (await this.pub.readContract({ address: this.dep.poolManager, abi: ABI, functionName: 'extsload', args: [liqSlot] })) as Hex
    return { sqrtPriceX96: BigInt(s0) & ((1n << 160n) - 1n), liquidity: BigInt(l) & ((1n << 128n) - 1n) }
  }
  private priceFromSqrt(r: PoolRt, sqrtX96: bigint): number {
    const s = Number(sqrtX96) / 2 ** 96
    const raw = s * s
    return r.stockIsC0 ? raw * 10 ** (r.dStock - r.dUsd) : 10 ** (r.dStock - r.dUsd) / raw
  }
  async poolState(p: PoolRef): Promise<PoolState> {
    const r = this.rt(p)
    const { sqrtPriceX96, liquidity } = await this.slot0(r)
    return { priceUsd: this.priceFromSqrt(r, sqrtPriceX96), L: Number(liquidity) / 10 ** ((r.dStock + r.dUsd) / 2) }
  }
  async oracle(t: Ticker): Promise<OracleView> {
    const feedId = this.dep.tickers[t]!.feedId
    const [priceE8, asOf, open] = (await this.pub.readContract({ address: this.dep.oracle, abi: ABI, functionName: 'priceOf', args: [feedId] })) as readonly [bigint, bigint, boolean]
    return { priceUsd: Number(priceE8) / 1e8, asOf: Number(asOf), sessionOpen: open }
  }
  async pushReport(t: Ticker, priceUsd: number, sessionOpen: boolean, asOf: number): Promise<void> {
    const w = this.wallets.get('feeder')!
    const report = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'bool' }, { type: 'uint64' }],
      [this.dep.tickers[t]!.feedId, BigInt(Math.round(priceUsd * 1e8)), sessionOpen, BigInt(asOf)],
    )
    const h = await w.writeContract({ address: this.dep.forwarder, abi: ABI, functionName: 'deliver', args: [this.dep.oracle, report], chain: foundry, account: w.account!, gas: 400_000n })
    await this.pub.waitForTransactionReceipt({ hash: h })
  }
  async quote(p: PoolRef, side: Side) {
    const r = this.rt(p)
    if (p.kind === 'control') return { feePips: r.key.fee, arbDirection: false }
    const zeroForOne = side === 'sellStock' ? r.stockIsC0 : !r.stockIsC0
    const [fee, , arb] = (await this.pub.readContract({ address: this.dep.hook, abi: ABI, functionName: 'quoteFee', args: [r.key, zeroForOne] })) as readonly [number, bigint, boolean]
    return { feePips: Number(fee), arbDirection: arb }
  }
  async swap(p: PoolRef, actor: Actor, side: Side, amountIn: number): Promise<SwapFill> {
    const r = this.rt(p)
    const w = this.wallets.get(actor === 'retail' ? 'retail' : 'arb')!
    const dIn = side === 'sellStock' ? r.dStock : r.dUsd
    const amountRaw = BigInt(Math.floor(amountIn * 10 ** Math.min(dIn, 12))) * 10n ** BigInt(Math.max(dIn - 12, 0))
    const fail = (error: string): SwapFill => ({ ok: false, error, feePips: 0, f0Pips: this.f0, usdDelta: 0, stockDelta: 0, feeUsd: 0, volumeUsd: 0, priceAfter: 0 })
    if (amountRaw <= 0n) return fail('zero amount')
    const zeroForOne = side === 'sellStock' ? r.stockIsC0 : !r.stockIsC0
    try {
      const hash = await w.writeContract({ address: this.dep.swapRouter, abi: ABI, functionName: 'swapExactIn', args: [r.key, zeroForOne, amountRaw, 0n], chain: foundry, account: w.account!, gas: 2_000_000n })
      const rc = await this.pub.waitForTransactionReceipt({ hash })
      if (rc.status !== 'success') return fail('reverted')
      const logs = parseEventLogs({ abi: ABI, eventName: 'Swap', logs: rc.logs }).filter((l) => l.address.toLowerCase() === this.dep.poolManager.toLowerCase() && (l.args as { id: Hex }).id.toLowerCase() === r.poolId.toLowerCase())
      const ev = logs[0]?.args as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; fee: number } | undefined
      if (!ev) return fail('no Swap event')
      // the v4 event reports the swapper's deltas (negative = swapper paid); the pool's view is the opposite
      const a0 = -Number(ev.amount0) / 10 ** (r.stockIsC0 ? r.dStock : r.dUsd)
      const a1 = -Number(ev.amount1) / 10 ** (r.stockIsC0 ? r.dUsd : r.dStock)
      const stockDelta = r.stockIsC0 ? a0 : a1
      const usdDelta = r.stockIsC0 ? a1 : a0
      const priceAfter = this.priceFromSqrt(r, ev.sqrtPriceX96)
      const feeRate = Number(ev.fee) / 1e6
      const feeUsd = (side === 'sellStock' ? stockDelta * priceAfter : usdDelta) * feeRate
      return { ok: true, feePips: Number(ev.fee), f0Pips: this.f0, usdDelta, stockDelta, feeUsd, volumeUsd: Math.abs(usdDelta), priceAfter, txHash: hash }
    } catch (e) {
      return fail((e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160))
    }
  }
  async close(): Promise<void> {}
}

export function loadDeployment(path: string): Deployment {
  if (!existsSync(path)) throw new Error(`no deployment at ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment
}
void join
