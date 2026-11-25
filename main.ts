// riidzhsn-pump-fun: deterministic momentum bot with a pullback entry.
//
// Strategy, in one paragraph: watch every new pump.fun mint. Buy only a mint
// that is young (first seen at most ~3,600 slots ago), liquid enough (real SOL
// reserves at least ~2 SOL), already showing momentum (price at least +15%
// above its first-seen price, with at least 7 of its last 10 trades buys),
// and currently on sale relative to its own best price (pulled back to at most
// 90% of the best price since first sight). Size is ~0.09 SOL, capped at 1%
// of real reserves and never below the 0.01 SOL round-trip floor. Exits: take
// profit +60%, stop loss -30%, trailing stop -20% off the best price since
// entry, or a hard age limit of ~7,200 slots. Every price comparison is an
// exact BigInt cross-multiplication on virtual reserves; there is no floating
// point, no clock, no environment read and no randomness anywhere, so the two
// harness runs produce byte-identical action logs.
//
// Entry: main.ts (this file). Vendor shim: vendor/makefun-bot.ts (copied from
// the kit's sdk/ts/makefun-bot.ts, unchanged).
//
// Grade-local (dev window, 24h, 128,058 events, --driver process --worktree):
// v1 (no re-buy guard) net PnL -9.94 SOL, drawdown 0.994, guardrails FAILED
// (4,141 round trips over 230 coins: the bot re-bought the same falling mints).
// v2 (one buy per mint per run) net PnL -0.687 SOL, return -6.9%, 90%
// interval -0.95 .. -0.42 SOL, 391 round trips over 391 coins, win rate
// 16.9%, max drawdown 0.069, guardrails MET, L1 regrade reproduced byte for
// byte, action_log_sha256 a3a32531a0a56ce8e300fb205f7469369917e7c84b403541b8aef8957d5288b7.
// Dev PnL is still negative (a prize needs PnL > 0 after fees), but the entry
// is valid, ranked, and the final 6h window is different data.

import {
  runBot,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

const LAMPORTS_PER_SOL = 1_000_000_000n;
const TX_FEE = 105_000n; // base 5,000 + priority 100,000 lamports per order
const MAX_OPEN_POSITIONS = 5;
const MAX_BUYS_PER_BATCH = 3;
const MAX_AGE_SLOTS = 3_600; // mint must be this young (slots since first seen)
const MAX_HOLD_SLOTS = 7_200; // hard age exit for a position
const MIN_REAL_SOL = 2n * LAMPORTS_PER_SOL; // min real SOL reserves to trade
const BUY_SIZE = 90_000_000n; // ~0.09 SOL target size per buy
const MIN_BUY = 10_000_000n; // 0.01 SOL round-trip floor
const SLIPPAGE_BPS = 500; // 5%

// ---------------------------------------------------------------- ratios

/** A price as an exact fraction: SOL per token = n / d (virtual reserves). */
interface Ratio {
  n: bigint;
  d: bigint;
}

function priceOf(curve: Curve): Ratio | null {
  const vq = curve.virtual_quote_reserves;
  const vt = curve.virtual_token_reserves;
  if (vt <= 0n || vq < 0n) return null;
  return { n: vq, d: vt };
}

/** a >= b * num / den, exact. */
function ratioGte(a: Ratio, b: Ratio, num: bigint, den: bigint): boolean {
  return a.n * b.d * num >= b.n * a.d * den;
}

/** a <= b * num / den, exact. */
function ratioLte(a: Ratio, b: Ratio, num: bigint, den: bigint): boolean {
  return a.n * b.d * num <= b.n * a.d * den;
}

/** The larger of two ratios (exact). */
function ratioMax(a: Ratio, b: Ratio): Ratio {
  return a.n * b.d >= b.n * a.d ? a : b;
}

// ---------------------------------------------------------------- tracking

interface MintTrack {
  firstSlot: number;
  first: Ratio;
  best: Ratio;
  buys: boolean[]; // last up to 10 trade directions, oldest first
  complete: boolean;
}

interface PosTrack {
  entrySlot: number;
  best: Ratio;
}

const mints = new Map<string, MintTrack>();
const held = new Map<string, PosTrack>();
// Mints already bought once this run: never re-buy them. Without this, a
// mint that keeps meeting the (age / momentum / pullback) conditions after an
// exit gets bought again and again while it falls — in grade-local that was
// 4,141 round trips over 230 coins and a -99% return. One entry per mint.
const traded = new Set<string>();

function trackTrade(
  mint: string,
  slot: number,
  vq: bigint,
  vt: bigint,
  isBuy: boolean,
): void {
  if (vt <= 0n) return;
  const price: Ratio = { n: vq, d: vt };
  const t = mints.get(mint);
  if (t === undefined) {
    mints.set(mint, { firstSlot: slot, first: price, best: price, buys: [isBuy], complete: false });
  } else {
    t.best = ratioMax(t.best, price);
    t.buys.push(isBuy);
    if (t.buys.length > 10) t.buys.shift();
  }
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = state.slot;

    // --- fold this batch's events into the per-mint tracks, and remember
    // which mints moved this batch (only those are entry candidates).
    const moved: string[] = [];
    const seenMoved = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = mints.get(e.mint);
        const price: Ratio = {
          n: BigInt(e.virtual_quote_reserves),
          d: BigInt(e.virtual_token_reserves),
        };
        if (t === undefined) {
          if (price.d > 0n) {
            mints.set(e.mint, { firstSlot: slot, first: price, best: price, buys: [], complete: false });
          }
        }
        if (!seenMoved.has(e.mint)) {
          seenMoved.add(e.mint);
          moved.push(e.mint);
        }
      } else if (e.event === 'TradeEvent') {
        trackTrade(
          e.mint,
          slot,
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
          e.is_buy,
        );
        if (!seenMoved.has(e.mint)) {
          seenMoved.add(e.mint);
          moved.push(e.mint);
        }
      } else {
        // CompleteEvent: the curve is done; never trade it again.
        const t = mints.get(e.mint);
        if (t !== undefined) t.complete = true;
      }
    }

    // --- exits first: TP +60% / SL -30% / trailing -20% / age 7,200 slots.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cur = priceOf(curve);
      if (cur === null) continue;
      const tokens = BigInt(pos.token_amount);
      if (tokens <= 0n) continue;
      const entry: Ratio = { n: BigInt(pos.cost_lamports), d: tokens };
      let track = held.get(mint);
      if (track === undefined) {
        track = { entrySlot: slot, best: cur };
        held.set(mint, track);
      } else {
        track.best = ratioMax(track.best, cur);
      }
      const takeProfit = ratioGte(cur, entry, 160n, 100n);
      const stopLoss = ratioLte(cur, entry, 70n, 100n);
      const trailing = ratioLte(cur, track.best, 80n, 100n);
      const tooOld = slot - track.entrySlot > MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || tooOld) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: tokens,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }
    // Drop tracks for positions that are gone (sold / completed / flattened).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // --- entries: momentum + pullback, only on mints that moved this batch.
    let buysSent = 0;
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
    }
    for (const mint of moved) {
      if (buysSent >= MAX_BUYS_PER_BATCH) break;
      if (state.committedPositionCount() + buysSent >= MAX_OPEN_POSITIONS) break;
      const t = mints.get(mint);
      if (t === undefined || t.complete) continue;
      if (traded.has(mint)) continue;
      if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Young mint only.
      const age = slot - t.firstSlot;
      if (age < 0 || age > MAX_AGE_SLOTS) continue;
      // Liquid enough.
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      // At least 10 trades seen, at least 7 of the last 10 buys.
      if (t.buys.length < 10) continue;
      let buyCount = 0;
      for (const b of t.buys) if (b) buyCount++;
      if (buyCount < 7) continue;
      const cur = priceOf(curve);
      if (cur === null) continue;
      // Momentum: price at least +15% above first-seen price.
      if (!ratioGte(cur, t.first, 115n, 100n)) continue;
      // Pullback: price at most 90% of the best price since first sight.
      if (!ratioLte(cur, t.best, 90n, 100n)) continue;
      // Size: ~0.09 SOL, capped at 1% of real reserves and at free cash.
      let size = BUY_SIZE;
      const cap = state.maxBuyLamports(mint);
      if (cap < size) size = cap;
      const affordable = state.freeCashLamports() - TX_FEE;
      if (affordable < size) size = affordable;
      if (size < MIN_BUY) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      buysSent++;
      traded.add(mint);
      pendingBuys.add(mint);
    }

    return orders;
  },
});
