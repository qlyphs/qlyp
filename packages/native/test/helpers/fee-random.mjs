// Seeded random fee schedule histories: governance by whoever holds each role, and wallet operations
// priced at an attested block and included within their era.
import { fee, RATE_MAX, RATE_MIN, checkRate } from '../../src/index.ts';
import { DEV_GENESIS, adminOp, deployOp, feeRateOp, harness, inscribeOp } from './fee-harness.mjs';
import { devAccount, feeRules, rulesWith } from './fee-fixtures.mjs';

/** mulberry32: a small deterministic PRNG, identical on every platform. */
export function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)] };
}
/** Rounds to 3 significant digits toward `toward`, so a clamped step never grows. */
function round3(r, toward) {
  const unit = 10n ** BigInt(Math.max(0, r.toString().length - 3));
  const down = (r / unit) * unit;
  return r > toward && down !== r ? down : r < toward && down !== r ? down + unit : r;
}
export const WINDOWS = {
  // Short windows keep the run fast; they satisfy every bound of the rules.
  development: { from: 5, delay: 400, grace: 320, guardianDelay: 400, legacyBefore: false },
  mainnet: { from: 5, delay: 7200, grace: 4608, guardianDelay: 50400, legacyBefore: false },
};
/**
 * A random history. A wallet prices each operation at the state of block `a` (the last applied
 * block), gives its era a birth `b` with a <= b <= a + maxBirthOffset on the same chain, and is
 * included at some h in (b, b + period). Returns the blocks and, per wallet operation, where it
 * landed and the rate it was priced with.
 */
export function randomHistory(seed, opts = {}) {
  const { windows = 'development', blocks = 2000, period = 256, maxBirthOffset = 0, walletRate = 0.04, govRate = 0.03 } = opts;
  const rnd = prng(seed);
  const rules = rulesWith(feeRules({ ...WINDOWS[windows], rate: '10000000000' }), { progressiveV2: { from: 1 } });
  const f = rules.feeSchedule;
  const h = harness(rules, opts.genesis ?? DEV_GENESIS);
  const pool = Array.from({ length: 10 }, (_, i) => devAccount(`acct-${seed}-${i}`));
  const pending = []; // wallet operations not yet included
  const wallet = [];
  let serial = 0, signers = 0;
  const ratesAt = [];
  const pendingSigner = (a) => pending.some((w) => w.signer === a);
  const named = () => rnd.pick([...pool, ...pending.map((w) => w.signer)]);
  for (let s = h.x.state(); s.height < blocks; s = h.x.state()) {
    const P = s.height + 1, fees = s.fees, receipts = [];
    if (fees && rnd.next() < govRate) {
      // Rates are posted mostly when nothing is pending, as a publisher does, so that grids get
      // promoted; replacements, cancels and freezes still happen.
      const action = rnd.pick(['rate', 'rate', 'rate', 'rate', 'rate', 'rate', 'cancel', 'freeze', 'setOperator', 'setOperator', 'setGuardian', 'setSentinel', 'setSentinel']);
      let signer, op;
      if (action === 'rate' && fees.operator && (fees.pending === null || rnd.next() < 0.02)) {
        const c = fees.current.rate;
        const r = round3((c * BigInt(800 + rnd.int(451))) / 1000n, c);
        if (checkRate(r) && 4n * r <= 5n * c && 5n * r >= 4n * c && r >= RATE_MIN && r <= RATE_MAX)
          [signer, op] = [fees.operator, feeRateOp(P + f.delay + rnd.int(f.delay + 1), r)];
      } else if (action === 'cancel' && rnd.next() < 0.3) [signer, op] = [rnd.pick([fees.operator, fees.sentinel, fees.guardian, named()]), adminOp('cancel')];
      else if (action === 'freeze' && rnd.next() < 0.1) [signer, op] = [rnd.pick([fees.sentinel, fees.guardian]), adminOp('freeze')];
      else if (action === 'setOperator') [signer, op] = [fees.guardian, adminOp('setOperator', named(), P + f.delay + rnd.int(f.delay + 1))];
      else if (action === 'setGuardian')
        [signer, op] = [fees.guardian, rnd.next() < 0.3 ? adminOp('setGuardian', fees.guardian, 0) : adminOp('setGuardian', named(), P + f.guardianDelay + rnd.int(f.guardianDelay + 1))];
      else if (action === 'setSentinel') [signer, op] = [fees.guardian, adminOp('setSentinel', named())];
      // A signer with a wallet operation in flight keeps its sequence for that operation.
      if (op && signer && !pendingSigner(signer)) receipts.push(h.remarkTx(signer, op));
    }
    if (fees && rnd.next() < walletRate) {
      // Priced at the attested block a = s.height; era born at b; included before b + period.
      const a = s.height, b = a + rnd.int(maxBirthOffset + 1);
      const signer = devAccount(`wallet-${seed}-${signers++}`);
      const kind = rnd.pick(['deploy', 'deployProgressiveV2', 'inscribe']);
      const op = kind === 'inscribe' ? inscribeOp() : deployOp('P' + (serial++).toString(36).toUpperCase(), kind);
      const w = { signer, op, a, rate: fees.current.rate, amount: fee(op, fees.current.rate), height: b + 1 + rnd.int(period - 1) };
      pending.push(w);
      wallet.push(w);
    }
    for (const w of pending.filter((w) => w.height === P)) {
      w.index = receipts.length;
      receipts.push(h.feeTx(w.signer, w.op, w.amount, { seq: 0n }));
    }
    h.block(receipts);
    ratesAt[P] = h.x.state().fees?.current.rate;
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].height === P) pending.splice(i, 1);
  }
  return { genesis: h.genesis, rules, blocks: h.blocks, wallet: wallet.filter((w) => w.height <= blocks), ratesAt, harness: h };
}
