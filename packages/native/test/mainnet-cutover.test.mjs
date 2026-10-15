// The mainnet fee schedule cutover: shipping the reader changes nothing on mainnet, the activation
// height keeps reading operations signed under the old rules for `grace` blocks, after which a legacy
// amount counts only as a fee of the current or previous grid, and a reader restores a checkpoint
// on either side of the activation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as current from '../src/index.ts';
import { activatedMainnet } from './helpers/activated-mainnet.mjs';
import { mainnetFeeRules } from './helpers/fee-fixtures.mjs';
import { ANCHOR, MAINNET, canonicalState, fromJson, reading } from './helpers/legacy-reader.mjs';

// A regression fixture of synthetic mainnet-genesis blocks, as read by the reader that ran before the
// fee schedule existed.
const PINNED = fromJson(readFileSync(new URL('./fixtures/mainnet-legacy-reading.json', import.meta.url), 'utf8'));
const LEGACY_DEPLOY = 1_000_000_000_000n,
  LEGACY_INSCRIBE = 100_000_000_000n;
// The activation, above the pinned blocks, and its schedule as the release pins it.
const H = 102_200;
const FEES = mainnetFeeRules(H);
const AT_RATE = 250_000_000_000n; // 25 USD at the genesis rate 1e10

test('below the release activation, mainnet reads every operation as the reader before fees-1', () => {
  // The release pins its activation above every pinned block, so it reads them unchanged.
  assert.equal(current.MAINNET_FEE_SCHEDULE.from, 218_350);
  assert.deepEqual(PINNED.anchor, ANCHOR);
  assert.deepEqual(reading(current, PINNED.blocks), PINNED.reading);
});

const { lib, harness, close } = await activatedMainnet(FEES);
test.after(close);
const RULES = lib.mainnetRules();
const id = harness.id;

test('the activated copy is the release: both pins at H, legacy reading kept around H', () => {
  assert.equal(lib.mainnetReviewed(), true);
  assert.deepEqual(RULES, { progressive: null, progressiveV2: { from: H }, feeSchedule: FEES });
  assert.equal(lib.mainnetRulesAllowed(RULES, ANCHOR.height), true);
});

test('pinning the schedule changes nothing below H', () => {
  assert.deepEqual(reading(lib, PINNED.blocks), PINNED.reading);
});

/** The receipt of a prepared fee batch, as the chain reports a successful one. */
const included = (signer, p) => ({
  signer,
  callHex: lib.hex(p.call),
  success: true,
  events: [
    { kind: 'remarked', sender: signer },
    { kind: 'paid', from: signer, to: lib.QLYPHS_FEE_ACCOUNT, amount: p.fee },
    { kind: 'batchCompleted' },
  ],
});
const deploy = (symbol) => ({ kind: 'deploy', symbol, decimals: 0, cap: 1000n, limit: 100n, policy: 'open' });
const inscribe = (content) => ({ kind: 'inscribe', contentType: 'text/plain', content });

/** The mainnet chain from the anchor to H - 1, where the old rules still apply. */
function toCutover() {
  const h = harness.harness(RULES, MAINNET, ANCHOR, 0xc0700000n);
  h.to(H);
  assert.equal(h.height(), H - 1);
  assert.equal(h.state().fees, null);
  return h;
}

test('operations signed under the old rules at H - 1 are read until H + grace, then rejected', () => {
  const h = toCutover();
  const before = h.state();
  const owners = [1, 2, 3, 4, 5, 6].map((n) => id(0xc0de00 + n));
  const signed = [
    lib.preflight(before, MAINNET, owners[0], deploy('ATH'), RULES),
    lib.preflight(before, MAINNET, owners[1], inscribe('0x01'), RULES),
    lib.preflight(before, MAINNET, owners[2], deploy('PLAIN'), RULES),
    lib.preflight(before, MAINNET, owners[3], deploy('LASTOK'), RULES),
    lib.preflight(before, MAINNET, owners[4], deploy('TOOLATE'), RULES),
    lib.preflight(before, MAINNET, owners[5], inscribe('0x02'), RULES),
  ].map((p, i) => [owners[i], p]);
  // Prepared below H, the release's own client prices with the legacy fees.
  assert.deepEqual(signed.map(([, p]) => p.fee), [LEGACY_DEPLOY, LEGACY_INSCRIBE, LEGACY_DEPLOY, LEGACY_DEPLOY, LEGACY_DEPLOY, LEGACY_INSCRIBE]);
  const results = (receipts) => {
    h.block(receipts);
    return h.results().map((r) => [r.verdict, r.feeKept]);
  };
  // At H: the old-rules deploy and inscription, next to an operation priced at the schedule.
  const atH = h.feeTx(id(0xc0de10), deploy('RATED'), AT_RATE);
  assert.deepEqual(results([included(...signed[0]), included(...signed[1]), atH]), [
    ['accepted', false],
    ['accepted', false],
    ['accepted', false],
  ]);
  assert.equal(h.height(), H);
  assert.notEqual(h.state().fees, null);
  // The schedule's other rules apply to old-rules operations: a blocked symbol is refused (no
  // Qlyphs client signs one, so this one comes from a third-party client).
  assert.deepEqual(results([included(...signed[2]), h.feeTx(id(0xc0de11), deploy('USDT'), LEGACY_DEPLOY)]), [
    ['accepted', false],
    ['rejected: symbol blocked', true],
  ]);
  // The last block of the window still reads the legacy fee; the next one does not.
  h.to(H + FEES.grace - 1);
  assert.deepEqual(results([included(...signed[3])]), [['accepted', false]]);
  assert.equal(h.height(), H + FEES.grace - 1);
  assert.deepEqual(results([included(...signed[4]), included(...signed[5])]), [
    ['rejected: fee does not match the fee schedule', true],
    ['rejected: fee does not match the fee schedule', true],
  ]);
  // MINT keeps its fixed fee on both sides of H.
  const mint = lib.preflight(h.state(), MAINNET, owners[0], { kind: 'mint', asset: lib.assetId(owners[0], 0n), amount: 5n }, RULES);
  assert.equal(mint.fee, lib.MINT_FEE);
  assert.deepEqual(results([included(owners[0], mint)]), [['accepted', false]]);
});

/** A chain across H with every fee-bearing kind, and its state after each block. */
function acrossCutover() {
  const h = toCutover();
  const states = new Map([[h.height(), h.state()]]);
  const A = id(0xa11ce), B = id(0xb0b);
  const step = (receipts = []) => {
    h.block(receipts);
    states.set(h.height(), h.state());
  };
  step([included(A, lib.preflight(h.state(), MAINNET, A, deploy('EDGE'), RULES))]); // H, old rules
  step([h.feeTx(B, deploy('NEXT'), AT_RATE)]); // H + 1
  step([h.feeTx(A, { kind: 'mint', asset: lib.assetId(A, 0n), amount: 7n }, lib.MINT_FEE)]); // H + 2
  step();
  return { h, states, A, B };
}

test('a mainnet checkpoint restores at H - 1, H and H + 1, and replays to the same state', () => {
  const { h, states } = acrossCutover();
  const last = h.state();
  for (const at of [H - 1, H, H + 1]) {
    const s = states.get(at);
    assert.equal(s.fees === null, at < H, `fee state at ${at}`);
    const x = lib.NativeIndexer.fromCheckpoint(MAINNET, s, false, RULES);
    for (const b of h.blocks.filter((b) => b.height > at)) x.apply(b);
    assert.equal(canonicalState(x.state()), canonicalState(last), `restored at ${at}`);
  }
  // Restoring is not a way around the reviewed rules.
  for (const rules of [lib.LEGACY_RULES, { ...RULES, feeSchedule: { ...FEES, legacyBefore: false } }, { ...RULES, progressiveV2: { from: H + 1 } }])
    assert.throws(() => lib.NativeIndexer.fromCheckpoint(MAINNET, states.get(H + 1), false, rules), /not enabled on mainnet|fee state differs/);
  // A fresh reader still starts before the activation.
  assert.throws(() => new lib.NativeIndexer(MAINNET, { height: H, hash: states.get(H).hash }, false, RULES), /not enabled on mainnet/);
  assert.doesNotThrow(() => new lib.NativeIndexer(MAINNET, { height: H - 1, hash: states.get(H - 1).hash }));
});

test('after a restore past H, deploys, inscriptions and mints prepare and are accepted', () => {
  const { h, states, A, B } = acrossCutover();
  for (const at of [H, H + 1]) {
    const x = lib.NativeIndexer.fromCheckpoint(MAINNET, states.get(at), false, RULES);
    for (const b of h.blocks.filter((b) => b.height > at)) x.apply(b);
    const s = x.state();
    const C = id(0xc0c0 + at);
    const ops = [
      [C, lib.preflight(s, MAINNET, C, deploy('AFTER'), RULES)],
      [B, lib.preflight(s, MAINNET, B, inscribe('0x03'), RULES)],
      [A, lib.preflight(s, MAINNET, A, { kind: 'mint', asset: lib.assetId(A, 0n), amount: 1n }, RULES)],
    ];
    assert.deepEqual(ops.map(([, p]) => p.fee), [AT_RATE, AT_RATE, lib.MINT_FEE]);
    x.apply({ height: s.height + 1, hash: id(0xfeed00 + at), parent: s.hash, spec: 152, txVersion: 6, finalized: s.height + 1, receipts: ops.map(([who, p], index) => ({ index, hash: id(0xfeee00 + at * 4 + index), ...included(who, p) })) });
    const after = x.state();
    assert.deepEqual(after.journal.filter((j) => j.height === s.height + 1).map((j) => j.verdict), ['accepted', 'accepted', 'accepted']);
  }
});

test('preflight defaults to the pinned mainnet rules, so a buy past H restores without them', () => {
  const { h } = acrossCutover();
  const s = h.state();
  assert.ok(s.height > H);
  const buy = { kind: 'buy', ticket: id(0x71c7e7) };
  // Passed explicitly or left to the default, the restore succeeds and only the ticket is refused.
  for (const args of [[RULES], []])
    assert.throws(() => lib.preflight(s, MAINNET, id(0xb0e), buy, ...args), /not a live ticket for this buyer/);
});

test('the legacy window covers mortal eras only: at the genesis rate a held legacy fee batch loses its fee from H + grace', () => {
  // Receipts carry no era, so the reader cannot tell a signature made before H from one made
  // after it. An immortal or long-held legacy signature is outside the guarantee (section 6.3 of
  // docs/extension/PROTOCOL-FEES.md): included at H + grace or later, it is accepted only if its amount is a fee
  // of the current or previous grid, which no legacy amount is at 1e10.
  const h = toCutover();
  const holder = id(0x401d);
  const held = [
    lib.preflight(h.state(), MAINNET, holder, deploy('HELD'), RULES),
    lib.preflight(h.state(), MAINNET, id(0x401e), inscribe('0x04'), RULES),
  ];
  assert.deepEqual(held.map((p) => p.fee), [LEGACY_DEPLOY, LEGACY_INSCRIBE]);
  for (const at of [H + FEES.grace, H + 2 * FEES.grace]) {
    h.to(at);
    h.block([included(holder, held[0]), included(id(0x401e), held[1])]);
    assert.equal(h.height(), at);
    assert.deepEqual(h.results().map((r) => [r.verdict, r.feeKept]), [
      ['rejected: fee does not match the fee schedule', true],
      ['rejected: fee does not match the fee schedule', true],
    ]);
  }
});

// Canonical rates within the ×5/4 step from the genesis rate 1e10 to the rates at which a legacy
// amount is also a rate-derived fee: 1 QTC per DEPLOY at 4e10 (QTC = 25 USD), 0.1 QTC per INSCRIBE
// at 4e9 (QTC = 250 USD).
const UP_TO_4E10 = [12_500_000_000n, 15_600_000_000n, 19_500_000_000n, 24_300_000_000n, 30_300_000_000n, 37_800_000_000n, 40_000_000_000n];
const DOWN_TO_4E9 = [8_000_000_000n, 6_400_000_000n, 5_120_000_000n, 4_100_000_000n, 4_000_000_000n];

/** Promotes each rate in turn through an operator FEE_RATE at the shortest delay; returns the
 * height at which the last one took effect. */
function promote(h, rates) {
  let effective;
  for (const rate of rates) {
    effective = h.height() + 1 + FEES.delay;
    h.block([h.remarkTx(FEES.operator, harness.feeRateOp(effective, rate))]);
    assert.equal(h.results()[0].verdict, 'accepted');
    h.to(effective + 1);
    assert.equal(h.state().fees.current.rate, rate);
  }
  return effective;
}

/** Legacy-priced DEPLOY and INSCRIBE signed at H - 1, rejected once the window closes at the
 * genesis rate, then included again after `rates` are promoted and the previous grid dropped. */
function heldAfterPromotion(rates) {
  const h = toCutover();
  const D = id(0x4a0d), I = id(0x4a0e);
  const held = [
    [D, lib.preflight(h.state(), MAINNET, D, deploy('KEPT'), RULES)],
    [I, lib.preflight(h.state(), MAINNET, I, inscribe('0x05'), RULES)],
  ];
  assert.deepEqual(held.map(([, p]) => p.fee), [LEGACY_DEPLOY, LEGACY_INSCRIBE]);
  // Control: at the genesis rate 1e10 neither legacy amount is a schedule fee.
  h.to(H + FEES.grace);
  h.block(held.map((x) => included(...x)));
  assert.equal(h.state().fees.current.rate, 10_000_000_000n);
  assert.deepEqual(h.results().map((r) => [r.verdict, r.feeKept]), [
    ['rejected: fee does not match the fee schedule', true],
    ['rejected: fee does not match the fee schedule', true],
  ]);
  const last = promote(h, rates);
  h.to(last + FEES.grace);
  h.block(held.map((x) => included(...x)));
  assert.equal(h.state().fees.previous, null);
  return h.results().map((r) => [r.verdict, r.feeKept]);
}

test('after H + grace a legacy DEPLOY amount is accepted when it is the current fee (rate 4e10)', () => {
  assert.equal(lib.fee(deploy('KEPT'), 40_000_000_000n), LEGACY_DEPLOY);
  assert.deepEqual(heldAfterPromotion(UP_TO_4E10), [
    ['accepted', false],
    ['rejected: fee does not match the fee schedule', true],
  ]);
});

test('after H + grace a legacy INSCRIBE amount is accepted when it is the current fee (rate 4e9)', () => {
  assert.equal(lib.fee(inscribe('0x05'), 4_000_000_000n), LEGACY_INSCRIBE);
  assert.deepEqual(heldAfterPromotion(DOWN_TO_4E9), [
    ['rejected: fee does not match the fee schedule', true],
    ['accepted', false],
  ]);
});
