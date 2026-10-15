/** Pricing vectors and independent Python parity; no chain or payment is exercised here. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PROGRESSIVE_MINT_PROFILE,
  PROGRESSIVE_MINT_PROFILE_V2,
  PROGRESSIVE_MINT_LOTS,
  PROGRESSIVE_MINT_TOTAL_FEE,
  PROGRESSIVE_MINT_TOTAL_FEE_V2,
  mintTicket,
  progressiveLotFee,
  progressiveMintQuote,
  requireProgressiveMint,
} from '../src/progressive-mint.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/progressive-mint.json', import.meta.url), 'utf8'));
const witness = fileURLToPath(new URL('./progressive-mint-witness.py', import.meta.url));
const max = (1n << 128n) - 1n;
const strings = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));
const runPython = (args, input) => {
  const result = spawnSync('python3', [witness, ...args], {
    input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Python terminated: ${result.signal}`);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('progressive pricing: one immutable profile and exact total budget', () => {
  assert.equal(PROGRESSIVE_MINT_PROFILE, fixture.profile);
  assert.equal(PROGRESSIVE_MINT_LOTS, BigInt(fixture.lots));
  assert.equal(PROGRESSIVE_MINT_TOTAL_FEE, BigInt(fixture.totalFee));
  assert.equal(fixture.tiers.length, 5);
  assert.equal(fixture.tiers.reduce((sum, t) => sum + (BigInt(t.last) - BigInt(t.first) + 1n) * BigInt(t.fee), 0n), PROGRESSIVE_MINT_TOTAL_FEE);
});

for (const supply of fixture.supplies) {
  test(`progressive pricing: all 1000 lots are supply-neutral for cap=${supply.cap}`, () => {
    const cap = BigInt(supply.cap), size = BigInt(supply.lotSize);
    let total = 0n, minted = 0n, previousFee = 0n;
    for (const tier of fixture.tiers) {
      for (let i = BigInt(tier.first); i <= BigInt(tier.last); i++) {
        const quote = progressiveMintQuote(cap, minted);
        assert.deepEqual(quote, {
          profile: fixture.profile, lotSize: size, mintedLots: i,
          remainingLots: 1000n - i, nextFee: BigInt(tier.fee),
        });
        const terms = requireProgressiveMint(cap, minted, size);
        assert.deepEqual(terms, { profile: fixture.profile, lot: i + 1n, amount: size, fee: BigInt(tier.fee) });
        assert.ok(terms.fee >= previousFee);
        previousFee = terms.fee;
        total += terms.fee;
        minted += size;
      }
    }
    assert.equal(minted, cap);
    assert.equal(total, PROGRESSIVE_MINT_TOTAL_FEE);
    assert.deepEqual(progressiveMintQuote(cap, minted), {
      profile: fixture.profile, lotSize: size, mintedLots: 1000n,
      remainingLots: 0n, nextFee: null,
    });
    assert.throws(() => requireProgressiveMint(cap, cap, size), { message: 'mint sold out' });
  });
}

for (const boundary of [200n, 400n, 600n, 800n]) {
  test(`progressive pricing: fee changes after lot ${boundary}, not before`, () => {
    const before = requireProgressiveMint(1000000n, (boundary - 1n) * 1000n, 1000n);
    const after = requireProgressiveMint(1000000n, boundary * 1000n, 1000n);
    assert.equal(before.lot, boundary);
    assert.equal(after.lot, boundary + 1n);
    assert.equal(before.fee, boundary / 200n * 100000000000n);
    assert.equal(after.fee - before.fee, 100000000000n);
  });
}

test('progressive pricing: cumulative fee vectors', () => {
  for (const vector of fixture.cumulative) {
    let total = 0n;
    for (let i = 0n; i < BigInt(vector.mintedLots); i++) total += progressiveMintQuote(1000n, i).nextFee;
    assert.equal(total, BigInt(vector.fee));
  }
});

for (const v of fixture.invalidQuotes) {
  test(`progressive pricing: rejects cap=${v.cap}, minted=${v.minted}`, () => {
    assert.throws(() => progressiveMintQuote(BigInt(v.cap), BigInt(v.minted)), { message: v.error });
  });
}

test('progressive pricing: no float, number, string, boolean or coercion of amounts', () => {
  for (const value of [0, 1000, Number.MAX_SAFE_INTEGER, NaN, Infinity, 1000.1, '1000', true, false, null, undefined, [], {}, { valueOf: () => 1000n }]) {
    assert.throws(() => progressiveMintQuote(value, 0n), { message: 'invalid supply' });
    assert.throws(() => progressiveMintQuote(1000000n, value), { message: 'invalid minted amount' });
    assert.throws(() => requireProgressiveMint(1000000n, 0n, value), { message: 'invalid mint amount' });
  }
});

test('progressive pricing: one whole lot, with no partial or multiple-lot shortcut', () => {
  for (const value of [1n, 500n, 999n, 1001n, 2000n, max + 1n]) {
    assert.throws(() => requireProgressiveMint(1000000n, 0n, value), { message: 'mint amount must equal one lot' });
  }
  for (const value of [0n, -1n]) {
    assert.throws(() => requireProgressiveMint(1000000n, 0n, value), { message: 'invalid mint amount' });
  }
});

test('progressive pricing: quotes are immutable and never reserve a lot', () => {
  const first = progressiveMintQuote(1000000n, 199000n);
  assert.deepEqual(progressiveMintQuote(1000000n, 199000n), first);
  assert.throws(() => { first.nextFee = 0n; }, TypeError);
  const mint = requireProgressiveMint(1000000n, 199000n, 1000n);
  assert.throws(() => { mint.fee = 0n; }, TypeError);
  assert.equal(progressiveMintQuote(1000000n, 200000n).nextFee, 200000000000n);
  assert.equal(first.nextFee, 100000000000n);
});

test('progressive pricing: scaling token denomination changes only token quantities', () => {
  for (let decimals = 0n; decimals <= 18n; decimals++) {
    const scale = 10n ** decimals;
    for (const i of [0n, 199n, 200n, 399n, 400n, 599n, 600n, 799n, 800n, 999n, 1000n]) {
      const a = progressiveMintQuote(21000000n, i * 21000n);
      const b = progressiveMintQuote(21000000n * scale, i * 21000n * scale);
      assert.equal(a.nextFee, b.nextFee);
      assert.equal(a.mintedLots, b.mintedLots);
      assert.equal(a.remainingLots, b.remainingLots);
      assert.equal(a.lotSize * scale, b.lotSize);
    }
  }
});

test('progressive pricing: independent Python unit suite', () => {
  runPython([], undefined);
});

test('progressive pricing: TS/Python parity over every lot, bounds and deterministic samples', () => {
  const cases = [];
  for (const supply of fixture.supplies) {
    const cap = BigInt(supply.cap), size = BigInt(supply.lotSize);
    for (let i = 0n; i <= 1000n; i++) cases.push({ cap, minted: i * size });
    for (const i of [0n, 199n, 200n, 399n, 400n, 599n, 600n, 799n, 800n, 999n, 1000n]) {
      cases.push({ cap, minted: i * size, amount: size });
    }
  }
  for (const v of fixture.invalidQuotes) cases.push({ cap: BigInt(v.cap), minted: BigInt(v.minted) });
  for (const amount of [-1n, 0n, 1n, 500n, 1000n, 2000n, max + 1n]) cases.push({ cap: 1000000n, minted: 0n, amount });
  // Fixed test generator, not a source of protocol randomness.
  let seed = 17n;
  for (let n = 0; n < 512; n++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & max;
    const size = seed % (max / 1000n) + 1n;
    const i = seed % 1001n;
    cases.push({ cap: size * 1000n, minted: size * i });
  }
  const expected = cases.map(({ cap, minted, amount }) => {
    try {
      return strings(amount === undefined ? progressiveMintQuote(cap, minted) : requireProgressiveMint(cap, minted, amount));
    } catch (error) {
      return { error: error.message };
    }
  });
  const actual = JSON.parse(runPython(['--probe'], JSON.stringify(strings(cases))));
  assert.equal(cases.length, 6601);
  assert.deepEqual(actual, expected);
});

test('progressive-1000-v2: its own fixed tiers, 210 QTC in all, the same lot structure', () => {
  // Written from the profile's definition: 0.01, 0.10, 0.20, 0.30 and 0.44 QTC per 200-lot tier.
  const tiers = [10_000_000_000n, 100_000_000_000n, 200_000_000_000n, 300_000_000_000n, 440_000_000_000n];
  assert.equal(PROGRESSIVE_MINT_PROFILE_V2, 'progressive-1000-v2');
  assert.equal(PROGRESSIVE_MINT_TOTAL_FEE_V2, 210_000_000_000_000n);
  for (const cap of [1000n, 21_000_000_000_000n, max / 1000n * 1000n]) {
    const size = cap / 1000n;
    let total = 0n;
    for (let i = 0n; i < 1000n; i++) {
      const q = progressiveMintQuote(cap, i * size, PROGRESSIVE_MINT_PROFILE_V2);
      assert.equal(q.profile, PROGRESSIVE_MINT_PROFILE_V2);
      assert.equal(q.nextFee, tiers[Number(i / 200n)]);
      assert.equal(progressiveLotFee(i + 1n, PROGRESSIVE_MINT_PROFILE_V2), q.nextFee);
      total += requireProgressiveMint(cap, i * size, size, PROGRESSIVE_MINT_PROFILE_V2).fee;
    }
    assert.equal(total, PROGRESSIVE_MINT_TOTAL_FEE_V2);
    assert.equal(progressiveMintQuote(cap, cap, PROGRESSIVE_MINT_PROFILE_V2).nextFee, null);
  }
  // The default stays progressive-1000-v1, and an unknown profile is refused.
  assert.equal(progressiveLotFee(1n), 100_000_000_000n);
  assert.throws(() => progressiveMintQuote(1000n, 0n, 'progressive-1000-v3'), /unknown profile/);
});

test('progressive-1000-v2: rights are named in their own domain', () => {
  const genesis = '0x' + '00'.repeat(32), asset = '0x' + '11'.repeat(40);
  const anchor = { height: 3, hash: '0x' + '07'.repeat(32), index: 3 };
  const v1 = mintTicket(genesis, asset, 0n, anchor), v2 = mintTicket(genesis, asset, 0n, anchor, PROGRESSIVE_MINT_PROFILE_V2);
  assert.equal(v1.nonce, v2.nonce);
  assert.notDeepEqual(v1.signers, v2.signers);
  assert.deepEqual(mintTicket(genesis, asset, 0n, anchor, PROGRESSIVE_MINT_PROFILE), v1);
});

test('progressive-1000-v2: TS/Python parity over every lot and bound', () => {
  const cases = [];
  for (const cap of [1000n, 21_000_000_000_000n, max / 1000n * 1000n]) {
    const size = cap / 1000n;
    for (let i = 0n; i <= 1000n; i++) cases.push({ cap, minted: i * size, profile: PROGRESSIVE_MINT_PROFILE_V2 });
    for (const i of [0n, 199n, 200n, 399n, 400n, 599n, 600n, 799n, 800n, 999n, 1000n])
      cases.push({ cap, minted: i * size, amount: size, profile: PROGRESSIVE_MINT_PROFILE_V2 });
  }
  for (const v of fixture.invalidQuotes) cases.push({ cap: BigInt(v.cap), minted: BigInt(v.minted), profile: PROGRESSIVE_MINT_PROFILE_V2 });
  cases.push({ cap: 1000n, minted: 0n, profile: 'progressive-1000-v3' });
  const expected = cases.map(({ cap, minted, amount, profile }) => {
    try {
      return strings(amount === undefined ? progressiveMintQuote(cap, minted, profile) : requireProgressiveMint(cap, minted, amount, profile));
    } catch (error) {
      return { error: error.message };
    }
  });
  assert.deepEqual(JSON.parse(runPython(['--probe'], JSON.stringify(strings(cases)))), expected);
});
