// The no-fee-loss property of the fee schedule: a wallet that prices at an attested block and gives
// its era a birth at that block never loses its fee to a rate change, on any branch that holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeIndexer, fee } from '../src/index.ts';
import { adminOp, deployOp, feeRateOp, harness } from './helpers/fee-harness.mjs';
import { GUARDIAN, OPERATOR, SENTINEL, devAccount, feeRules, rulesWith } from './helpers/fee-fixtures.mjs';
import { randomHistory } from './helpers/fee-random.mjs';

function check(run, replay = true) {
  const { harness: h, wallet, blocks, rules, genesis } = run;
  const journal = h.state().journal;
  let overlaps = 0;
  for (const w of wallet) {
    const j = journal.find((e) => e.height === w.height && e.index === w.index);
    assert.equal(j?.verdict, 'accepted', `priced at ${w.a}, included at ${w.height}`);
    // At inclusion, was the operation paying a grid that was no longer current?
    if (w.rate !== run.ratesAt[w.height]) overlaps++;
  }
  if (!replay) return overlaps;
  // The same blocks replay to the same state.
  const x = new NativeIndexer(genesis, { height: 0, hash: genesis }, false, rules);
  for (const b of blocks) x.apply(b);
  assert.deepEqual(x.state(), h.state());
  return overlaps;
}
test('random governance never costs a conforming wallet its fee (development windows, period 256)', () => {
  let overlaps = 0, ops = 0;
  for (const seed of [1, 2, 3]) {
    const run = randomHistory(seed, { blocks: 3000, period: 256, walletRate: 0.03 });
    ops += run.wallet.length;
    overlaps += check(run);
  }
  assert.ok(ops > 200, `${ops} wallet operations`);
  // The property is only meaningful if rates changed under signed operations.
  assert.ok(overlaps > 5, `${overlaps} operations paid a previous grid`);
});

test('third-party bound with the mainnet windows: birth up to 512 blocks after pricing, period 4096', () => {
  let overlaps = 0;
  // Two promotions at most in 16,000 blocks with a 7,200-block delay: enough to straddle one.
  const run = randomHistory(11, { windows: 'mainnet', blocks: 16_000, period: 4096, maxBirthOffset: 512, walletRate: 0.006, govRate: 0.004 });
  overlaps += check(run, false);
  assert.ok(overlaps > 0, `${overlaps} operations paid a previous grid`);
});

/** Two branches from a common ancestor that differ by `diverge` before a promotion. */
function fork(diverge) {
  const rules = rulesWith(feeRules({ from: 5, delay: 400, grace: 320, guardianDelay: 400, legacyBefore: false }));
  const base = harness(rules);
  base.to(5);
  base.block([base.remarkTx(OPERATOR, feeRateOp(406, 12_500_000_000n))]); // P = 5, E = 405 + 1
  base.to(400);
  const ancestor = base.blocks.slice();
  const branch = (hashBase) => {
    const b = harness(rules, base.genesis, undefined, hashBase);
    for (const blk of ancestor) b.x.apply(blk);
    b.blocks.push(...ancestor);
    return b;
  };
  // Distinct hash ranges: the branches share blocks up to 399 and differ from block 400 on.
  const A = branch(0xa000000000n), B = branch(0xb000000000n);
  A.block();
  B.block([diverge(B)]);
  assert.equal(B.results()[0].verdict, 'accepted');
  for (const c of [A, B]) c.to(411);
  return { A, B, rules };
}
for (const [name, diverge] of [
  ['CANCEL', (B) => B.remarkTx(SENTINEL, adminOp('cancel'))],
  ['FREEZE', (B) => B.remarkTx(GUARDIAN, adminOp('freeze'))],
  ['a replacing FEE_RATE', (B) => B.remarkTx(OPERATOR, feeRateOp(810, 12_000_000_000n))],
]) {
  test(`forked: branches that differ by ${name} before a promotion`, () => {
    const { A, B } = fork(diverge);
    assert.equal(A.state().fees.current.rate, 12_500_000_000n);
    assert.equal(B.state().fees.current.rate, 10_000_000_000n);
    const U = devAccount('fork-user');
    // Priced at a on A, era born at a: valid only on chains that contain a, where it is accepted.
    // On B the extrinsic is invalid natively, so there is no receipt at all.
    const a = A.state(), priced = fee(deployOp('FORK'), a.fees.current.rate);
    assert.equal(A.one(A.feeTx(U, deployOp('FORK'), priced)), 'accepted');
    // Priced at the common ancestor: the grid is current on B and previous on A, within grace.
    const g0 = fee(deployOp('OLD'), 10_000_000_000n);
    assert.equal(A.one(A.feeTx(devAccount('fork-old'), deployOp('OLD'), g0)), 'accepted');
    assert.equal(B.one(B.feeTx(devAccount('fork-old'), deployOp('OLD'), g0)), 'accepted');
    // Negative control: priced on A but with an era born on B, the operation lands on B and is
    // rejected. This is the case the birth rule exists to exclude.
    const r = B.feeTx(U, deployOp('FORK'), priced);
    B.block([r]);
    assert.deepEqual(B.results(), [{ index: 0, verdict: 'rejected: fee does not match the fee schedule', feeKept: true }]);
  });
}
