// The fees-1 fee schedule: codec, fee formula, blocked tickers, the fee rule, governance and the
// client gates. Expectations are the specification's own numbers and verdict strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BLOCKED, ED, FEE_TARGETS_CENTS, GENESIS_GRID_INDEX, LEGACY_DEPLOY_FEE, LEGACY_INSCRIBE_FEE, LEGACY_RULES,
  MAINNET, MINT_FEE, RATE_MAX, RATE_MIN, RESERVED_TAGS, TICKERS_DIGEST, ZERO, assetId, buildCall, callBytes,
  centsFor, checkFeeRules, checkRate, checkRules, decode, encode, fee, feeAt, feeBasis, feeGovernanceCall, feeKept,
  feeMode, feeScheduleInput, feeScheduleView, fromHex, governancePreflight, hex, isFeeBearing, isRateDerived,
  legacyFee, NativeIndexer, parseCall, parseCommand, preflight, profileRules, progressiveRules, qlyphsFee,
  rateError, symbolClass, DEVELOPMENT,
} from '../src/index.ts';
import { FEE, DEV_GENESIS, adminOp, deployOp, feeRateOp, harness, id, inscribeOp } from './helpers/fee-harness.mjs';
import { GUARDIAN, OPERATOR, SENTINEL, devAccount, feeRules, rulesWith } from './helpers/fee-fixtures.mjs';
import { unactivatedMainnet } from './helpers/activated-mainnet.mjs';

// Mainnet as it read before the activation release: the release pins both activations, so the
// pre-activation reading is checked on a copy with both pins null.
const unactivated = await unactivatedMainnet();
test.after(unactivated.close);

const R = 10_000_000_000n; // 1e10: QTC = 100 USD
const D = 250_000_000_000n; // the DEPLOY and INSCRIBE fee at 1e10
const U = devAccount('user'), V = devAccount('user-2'), W = devAccount('user-3');
const NEWOP = devAccount('new-operator'), NEWG = devAccount('new-guardian'), NEWS = devAccount('new-sentinel');
const WALLET_MAX_RATE = 40_000_000_000n;
const PROGRESSIVE = { progressive: { from: 1 }, progressiveV2: { from: 1 } };
/** A chain whose schedule starts at block 10, advanced to that block (fee state installed). */
function live(over = {}, extra = {}) {
  const h = harness(rulesWith(feeRules(over), extra));
  h.to(over.from ?? 10);
  h.block();
  return h;
}
const P = (h) => h.height() + 1;
const gov = (h, signer, op) => h.one(h.remarkTx(signer, op));
const pay = (h, signer, op, amount, o) => h.one(h.feeTx(signer, op, amount, o));
const fees = (h) => h.state().fees;

// ------------------------------------------------------------------------------------ codec
test('encodings: FEE_RATE is 58 bytes, FEE_ADMIN 47, 83 or 79, all canonical', () => {
  const env = (op, sequence = 7n) => ({ genesis: DEV_GENESIS, sequence, op });
  const on = { feeSchedule: true };
  const rate = encode(env(feeRateOp(0x01020304, R)));
  assert.equal(rate.length, 58);
  assert.equal(hex(rate.slice(45)), '0x0d' + '04030201' + '00e40b5402000000');
  assert.deepEqual(decode(rate, on), env(feeRateOp(0x01020304, R)));
  const ops = [
    [adminOp('cancel'), 47, '00'],
    [adminOp('freeze'), 47, '01'],
    [adminOp('setOperator', NEWOP, 600), 83, '02'],
    [adminOp('setGuardian', NEWG, 601), 83, '03'],
    [adminOp('setSentinel', NEWS), 79, '04'],
  ];
  for (const [op, length, action] of ops) {
    const b = encode(env(op));
    assert.equal(b.length, length, op.action);
    assert.equal(hex(b.slice(45, 47)), '0x0e' + action);
    assert.deepEqual(decode(b, on), env(op));
    // A trailing byte, or a body of another action's length, fails canonical decoding.
    assert.throws(() => decode(Uint8Array.from([...b, 0]), on), /trailing bytes/);
    assert.throws(() => decode(b.slice(0, -1), on), length === 47 ? /truncated input|trailing/ : /truncated input/);
    for (const other of [0, 32, 36].filter((n) => n !== length - 47)) {
      const wrong = Uint8Array.from([...b.slice(0, 47), ...new Uint8Array(other)]);
      assert.throws(() => decode(wrong, on), /trailing bytes|truncated input/, `${op.action} with a ${other}-byte body`);
    }
  }
  assert.throws(() => decode(Uint8Array.from([...rate, 0]), on), /trailing bytes/);
  assert.throws(() => decode(rate.slice(0, -1), on), /truncated input/);
  const five = encode(env(adminOp('cancel'))); five[46] = 5;
  assert.throws(() => decode(five, on), /unknown fee admin action/);
  // Before the schedule's first block, tags 13 and 14 are unknown operations.
  for (const b of [rate, encode(env(adminOp('freeze')))]) {
    assert.throws(() => decode(b), /unknown operation/);
    assert.throws(() => decode(b, { progressive: true, progressiveV2: true }), /unknown operation/);
  }
  // Tag 15 is reserved at every height.
  assert.ok(RESERVED_TAGS.includes(15));
  const reserved = encode(env(adminOp('cancel'))); reserved[45] = 15;
  for (const o of [{}, on]) assert.throws(() => decode(reserved.slice(0, 46), o), /reserved operation/);
  // The codec checks syntax only: a zero rate and any effective encode; the reducer judges them.
  assert.deepEqual(decode(encode(env(feeRateOp(0, 0n))), on), env(feeRateOp(0, 0n)));
  assert.throws(() => encode(env(feeRateOp(2 ** 32, R))), /invalid effective height/);
  assert.throws(() => encode(env(feeRateOp(1, 1n << 64n))), /integer out of range/);
  assert.throws(() => encode(env({ kind: 'feeAdmin', action: 'pause' })), /unknown fee admin action/);
});

test('user payloads keep their bytes', () => {
  // Pinned against the encoding of the release before fees-1.
  const e = { genesis: id(1), sequence: 1n, op: { kind: 'deploy', symbol: 'ABC', decimals: 6, cap: 10n, limit: 5n, policy: 'open' } };
  assert.equal(
    createHash('sha256').update(encode(e)).digest('hex'),
    createHash('sha256').update(Buffer.from('514c595001' + '00'.repeat(31) + '01' + '0100000000000000' + '000c414243' + '06' + '0a' + '00'.repeat(15) + '05' + '00'.repeat(15) + '00', 'hex')).digest('hex'),
  );
});

// ------------------------------------------------------------------------------- fee formula
test('fee(): DEPLOY and INSCRIBE at the reference rates, one flat DEPLOY price, the ED floor', () => {
  const ins = inscribeOp();
  for (const [rate, amount] of [[RATE_MIN, 5_000_000_000n], [R, 250_000_000_000n], [RATE_MAX, 5_000_000_000_000n]]) {
    assert.equal(fee(deployOp('ABC'), rate), amount);
    assert.equal(fee(ins, rate), amount);
  }
  for (const kind of ['deploy', 'deployProgressive', 'deployProgressiveV2'])
    for (const symbol of ['Q', 'ABC', 'ABCDEFGHIJKL']) assert.equal(fee(deployOp(symbol, kind), R), 250_000_000_000n);
  assert.deepEqual(FEE_TARGETS_CENTS, { deploy: 2_500n, inscribe: 2_500n });
  assert.ok(Object.isFrozen(FEE_TARGETS_CENTS));
  // A 1-cent target at 2e8 is 2_000_000, floored to the existential deposit.
  assert.equal((1n * RATE_MIN) / 100n, 2_000_000n);
  assert.equal(feeAt(1n, RATE_MIN), ED);
  assert.equal(ED, 1_000_000_000n);
  // The wallet ceiling: 1 QTC for both at WALLET_MAX_RATE.
  assert.equal(fee(deployOp('ABC'), WALLET_MAX_RATE), 1_000_000_000_000n);
  assert.equal(fee(ins, WALLET_MAX_RATE), 1_000_000_000_000n);
  assert.throws(() => fee(ins, R + 1n), /rate not canonical/);
  assert.throws(() => fee(ins, RATE_MAX + 100_000_000n), /rate out of bounds/);
});

test('MINT is not rate-derived: centsFor and fee refuse it; legacy fees exist only for rate-derived kinds', () => {
  const mint = { kind: 'mint', asset: assetId(U, 0n), amount: 1n };
  assert.throws(() => centsFor(mint), /the mint fee is not rate-derived/);
  assert.throws(() => fee(mint, R), /the mint fee is not rate-derived/);
  assert.throws(() => legacyFee('mint'), /the mint fee is not rate-derived/);
  assert.throws(() => centsFor({ kind: 'transfer', asset: assetId(U, 0n), amount: 1n, to: V }), /not rate-derived/);
  assert.equal(isFeeBearing('mint'), true);
  assert.equal(isRateDerived('mint'), false);
  for (const k of ['deploy', 'inscribe', 'deployProgressive', 'deployProgressiveV2']) {
    assert.equal(isFeeBearing(k), true);
    assert.equal(isRateDerived(k), true);
  }
  for (const k of ['transfer', 'offer', 'feeRate', 'feeAdmin', 'mintProgressive']) assert.equal(isFeeBearing(k), false);
  assert.equal(legacyFee('deploy'), LEGACY_DEPLOY_FEE);
  assert.equal(legacyFee('deployProgressiveV2'), LEGACY_DEPLOY_FEE);
  assert.equal(legacyFee('inscribe'), LEGACY_INSCRIBE_FEE);
  assert.equal(LEGACY_DEPLOY_FEE, 1_000_000_000_000n);
  assert.equal(LEGACY_INSCRIBE_FEE, 100_000_000_000n);
  assert.equal(MINT_FEE, 10_000_000_000n);
});

test('checkRate: bounds, then 3 significant digits', () => {
  for (const [r, ok] of [
    [RATE_MIN, true], [RATE_MAX, true], [RATE_MIN - 100n, false], [RATE_MAX + 100_000_000n, false],
    [12_300_000_000n, true], [12_340_000_000n, false], [0n, false],
  ])
    assert.equal(checkRate(r), ok, String(r));
  assert.equal(rateError(RATE_MIN - 100n), 'rate out of bounds');
  assert.equal(rateError(12_340_000_000n), 'rate not canonical');
  assert.equal(rateError(R), null);
});

test('blocked tickers: the six symbols, exact membership, a pinned digest', () => {
  assert.deepEqual([...BLOCKED], ['BTC', 'ETH', 'QLYPHS', 'QTC', 'USDC', 'USDT']);
  assert.ok(Object.isFrozen(BLOCKED));
  const digest = createHash('sha512').update(Buffer.concat([Buffer.from('Qlyphs/QLYP/tickers/v1\0'), Buffer.from('{"blocked":["BTC","ETH","QLYPHS","QTC","USDC","USDT"]}')])).digest('hex');
  assert.equal(TICKERS_DIGEST, digest);
  assert.equal(TICKERS_DIGEST, '623d047831fa2b0b4c90d533d879dc0cd79c1b33d2190f01b3d44cd251f484fd4943a1c33ad125f346a37179da4d52c820de4178548d931c876316818e50f3ea');
  for (const s of BLOCKED) {
    assert.equal(symbolClass(s), 'blocked');
    assert.throws(() => centsFor(deployOp(s)), /symbol blocked/);
  }
  for (const s of ['USDT0', 'WBTC', 'QUANTUS', 'QLYP', 'DOGE', 'PEPE', 'DAI', 'M', 'BTC1', 'ETHS', 'USDCX', 'QLYPH'])
    assert.equal(symbolClass(s), 'allowed');
  for (const s of ['btc', '', 'ABCDEFGHIJKLM', 'BTC ', 'É']) assert.throws(() => symbolClass(s), /invalid symbol/);
});

// --------------------------------------------------------------------------------- rules
test('checkRules is strict: three keys, the exact fee schedule keys, a string rate', () => {
  const f = feeRules();
  assert.deepEqual(checkRules(rulesWith(f)), rulesWith(f));
  assert.deepEqual(Object.keys(checkFeeRules(f)), ['from', 'operator', 'guardian', 'sentinel', 'rate', 'delay', 'grace', 'guardianDelay', 'legacyBefore', 'resets']);
  const reset = { at: 20, operator: NEWOP, guardian: NEWG, sentinel: NEWS };
  assert.deepEqual(checkFeeRules(feeRules({ resets: [reset] })).resets, [reset]);
  const { resets: _r, ...missing } = f;
  for (const bad of [
    { progressive: null, progressiveV2: null },
    { ...rulesWith(f), extra: null },
    rulesWith(missing),
    rulesWith({ ...f, extra: 1 }),
    rulesWith({ ...f, rate: 10_000_000_000 }),
    rulesWith({ ...f, rate: '010000000000' }),
    rulesWith({ ...f, rate: '12340000000' }),
    rulesWith({ ...f, rate: '100000000' }),
    rulesWith({ ...f, grace: 319, delay: 600 }),
    rulesWith({ ...f, grace: 600, delay: 600 }),
    rulesWith({ ...f, delay: 1_000_001, guardianDelay: 1_000_001 }),
    rulesWith({ ...f, guardianDelay: 599 }),
    rulesWith({ ...f, guardianDelay: 600.5 }),
    rulesWith({ ...f, from: 0 }),
    rulesWith({ ...f, from: 1.5 }),
    rulesWith({ ...f, operator: OPERATOR.toUpperCase().replace('0X', '0x') }),
    rulesWith({ ...f, operator: GUARDIAN }),
    rulesWith({ ...f, sentinel: ZERO }),
    rulesWith({ ...f, guardian: FEE }),
    rulesWith({ ...f, legacyBefore: 1 }),
    rulesWith({ ...f, resets: Array.from({ length: 9 }, (_, i) => ({ ...reset, at: 20 + i })) }),
    rulesWith({ ...f, resets: [{ ...reset, at: 10 }] }),
    rulesWith({ ...f, resets: [reset, { ...reset, at: 20 }] }),
    rulesWith({ ...f, resets: [{ ...reset, extra: 1 }] }),
    rulesWith({ ...f, resets: [{ ...reset, sentinel: NEWOP }] }),
    rulesWith({ ...f, resets: [{ ...reset, operator: FEE }] }),
    rulesWith({ ...f, resets: {} }),
  ])
    assert.throws(() => checkRules(bad), JSON.stringify(bad).slice(0, 120));
  assert.equal(checkFeeRules(feeRules({ resets: Array.from({ length: 8 }, (_, i) => ({ ...reset, at: 20 + i })) })).resets.length, 8);
});

test('configured fee schedules: development parses strict JSON, mainnet refuses any value', () => {
  assert.equal(feeScheduleInput('development', undefined), null);
  assert.equal(feeScheduleInput('development', ''), null);
  assert.equal(feeScheduleInput('development', 'null'), null);
  assert.deepEqual(feeScheduleInput('development', JSON.stringify(feeRules())), feeRules());
  for (const raw of ['{', '[]', JSON.stringify({ ...feeRules(), rate: 10_000_000_000 }), JSON.stringify({ ...feeRules(), x: 1 })])
    assert.throws(() => feeScheduleInput('development', raw), /invalid fee schedule/);
  for (const raw of ['null', JSON.stringify(feeRules()), '{']) assert.throws(() => feeScheduleInput('mainnet', raw), /reviewed release only/);
  assert.equal(feeScheduleInput('mainnet', ''), null);
  assert.deepEqual(progressiveRules('development', undefined, undefined, undefined), LEGACY_RULES);
  assert.deepEqual(progressiveRules('development', undefined, undefined, JSON.stringify(feeRules())), rulesWith(feeRules()));
  assert.deepEqual(progressiveRules('development', '5', '6', JSON.stringify(feeRules())), rulesWith(feeRules(), { progressive: { from: 5 }, progressiveV2: { from: 6 } }));
  assert.throws(() => progressiveRules('mainnet', undefined, undefined, JSON.stringify(feeRules())), /reviewed release only/);
  assert.deepEqual(profileRules(DEVELOPMENT, undefined, undefined, JSON.stringify(feeRules())), rulesWith(feeRules()));
});

test('feeMode: legacy, schedule or inactive; without a schedule, clients treat mainnet fees as inactive', () => {
  const on = rulesWith(feeRules()), off = rulesWith(feeRules({ legacyBefore: false }));
  assert.equal(feeMode(LEGACY_RULES, DEV_GENESIS, 5), 'legacy');
  assert.equal(feeMode(LEGACY_RULES, MAINNET, 5), 'inactive');
  assert.equal(feeMode(on, DEV_GENESIS, 9), 'legacy');
  assert.equal(feeMode(off, DEV_GENESIS, 9), 'inactive');
  for (const r of [on, off]) assert.equal(feeMode(r, DEV_GENESIS, 10), 'schedule');
});

test('the indexer refuses a schedule that starts at or before its activation block', () => {
  assert.throws(() => new NativeIndexer(DEV_GENESIS, { height: 10, hash: DEV_GENESIS }, true, rulesWith(feeRules())), /fee schedule must start after the activation block/);
  assert.doesNotThrow(() => new NativeIndexer(DEV_GENESIS, { height: 9, hash: DEV_GENESIS }, true, rulesWith(feeRules())));
});

// -------------------------------------------------------------------------- fee state and step
test('the genesis grid is installed at from, not before; checkpoints must agree with the rules', () => {
  const h = harness(rulesWith(feeRules()));
  h.to(10);
  assert.equal(fees(h), null);
  h.block();
  assert.deepEqual(fees(h), {
    operator: OPERATOR, guardian: GUARDIAN, sentinel: SENTINEL, pendingOperator: null, pendingGuardian: null,
    current: { id: 0, rate: R, effective: 10, height: 10, index: GENESIS_GRID_INDEX },
    previous: null, pending: null, nextGrid: 1, nextReset: 0,
  });
  const s = h.state();
  assert.doesNotThrow(() => NativeIndexer.fromCheckpoint(DEV_GENESIS, s, false, rulesWith(feeRules())));
  assert.throws(() => NativeIndexer.fromCheckpoint(DEV_GENESIS, s, false, LEGACY_RULES), /checkpoint fee state differs from rules/);
  assert.throws(() => NativeIndexer.fromCheckpoint(DEV_GENESIS, { ...s, fees: null }, false, rulesWith(feeRules())), /checkpoint fee state differs from rules/);
  const before = harness(rulesWith(feeRules())); before.to(9);
  assert.throws(() => NativeIndexer.fromCheckpoint(DEV_GENESIS, { ...before.state(), fees: s.fees }, false, rulesWith(feeRules())), /checkpoint fee state differs from rules/);
  // A restored indexer keeps applying the schedule.
  const x = NativeIndexer.fromCheckpoint(DEV_GENESIS, s, false, rulesWith(feeRules()));
  x.apply({ height: 11, hash: id(0xaaa), parent: s.hash, spec: 152, txVersion: 6, finalized: 11, receipts: [] });
  assert.deepEqual(x.state().fees, s.fees);
});

test('FEE_RATE: effective edges, bounds, canonicity and the step against current', () => {
  const h = live();
  let p = P(h);
  assert.equal(gov(h, OPERATOR, feeRateOp(p + 599, 12_500_000_000n)), 'rejected: invalid effective height');
  p = P(h);
  assert.equal(gov(h, OPERATOR, feeRateOp(p + 1201, 12_500_000_000n)), 'rejected: invalid effective height');
  p = P(h);
  assert.equal(gov(h, OPERATOR, feeRateOp(p + 1200, 12_500_000_000n)), 'accepted');
  p = P(h);
  assert.equal(gov(h, OPERATOR, feeRateOp(p + 600, 12_500_000_000n)), 'accepted');
  for (const [rate, verdict] of [
    [RATE_MIN - 100n, 'rate out of bounds'], [RATE_MAX + 100_000_000n, 'rate out of bounds'], [12_340_000_000n, 'rate not canonical'],
    [12_600_000_000n, 'rate step too large'], [7_990_000_000n, 'rate step too large'],
  ]) {
    p = P(h);
    assert.equal(gov(h, OPERATOR, feeRateOp(p + 600, rate)), 'rejected: ' + verdict, String(rate));
  }
  // Exactly x4/5 is accepted, and the step is measured against current, not the pending grid.
  p = P(h);
  assert.equal(gov(h, OPERATOR, feeRateOp(p + 600, 8_000_000_000n)), 'accepted');
  assert.equal(fees(h).pending.rate, 8_000_000_000n);
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
  assert.equal(gov(h, NEWOP, feeRateOp(P(h) + 600, R)), 'rejected: not the fee operator');
  // Rejected governance never advances the sequence: OPERATOR made 4 accepted operations.
  assert.equal(h.seq(OPERATOR), 4n);
  assert.equal(fees(h).nextGrid, 5);
});

test('windows: promotion, the previous grid during grace, a replacing FEE_RATE', () => {
  const h = live();
  assert.equal(gov(h, OPERATOR, feeRateOp(611, 12_500_000_000n)), 'accepted'); // P = 11
  assert.equal(gov(h, OPERATOR, feeRateOp(612, 12_000_000_000n)), 'accepted'); // replaces it
  assert.deepEqual(fees(h).pending, { id: 2, rate: 12_000_000_000n, effective: 612, height: 12, index: 0 });
  assert.equal(fees(h).nextGrid, 3);
  h.to(611);
  h.block();
  assert.equal(fees(h).current.rate, R, 'the replaced grid never applies');
  // The promotion block: an operation in it sees the new current and the previous grid.
  const now = 300_000_000_000n;
  h.block([h.feeTx(U, deployOp('NEW'), now), h.feeTx(V, deployOp('OLD'), D), h.feeTx(W, deployOp('MID'), 275_000_000_000n)]);
  assert.equal(h.height(), 612);
  assert.deepEqual(h.results().map((r) => r.verdict), ['accepted', 'accepted', 'rejected: fee does not match the fee schedule']);
  assert.deepEqual(fees(h).previous, { id: 0, rate: R, effective: 10, height: 10, index: GENESIS_GRID_INDEX });
  h.to(612 + 384 - 1);
  assert.equal(pay(h, U, inscribeOp(), D), 'accepted'); // E + grace - 1
  assert.notEqual(fees(h).previous, null);
  const r = h.feeTx(U, inscribeOp('0x02'), D);
  assert.equal(h.one(r), 'rejected: fee does not match the fee schedule'); // E + grace
  assert.equal(h.results()[0].feeKept, true);
  assert.equal(fees(h).previous, null);
  assert.equal(pay(h, U, inscribeOp('0x03'), now), 'accepted');
});

test('CANCEL by each role, FREEZE, and a frozen operator', () => {
  const h = live();
  for (const role of [OPERATOR, SENTINEL, GUARDIAN]) {
    assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
    assert.equal(gov(h, role, adminOp('cancel')), 'accepted');
    assert.equal(fees(h).pending, null);
  }
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
  assert.equal(gov(h, U, adminOp('cancel')), 'rejected: not a fee role');
  assert.equal(gov(h, NEWOP, adminOp('freeze')), 'rejected: not the fee guardian or sentinel');
  assert.equal(gov(h, OPERATOR, adminOp('freeze')), 'rejected: not the fee guardian or sentinel');
  assert.equal(gov(h, SENTINEL, adminOp('freeze')), 'accepted');
  assert.equal(fees(h).operator, null);
  assert.equal(fees(h).pending, null);
  assert.equal(gov(h, GUARDIAN, adminOp('freeze')), 'accepted'); // already frozen
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'rejected: fee operator frozen');
  assert.equal(gov(h, OPERATOR, adminOp('cancel')), 'rejected: not a fee role');
  assert.equal(gov(h, SENTINEL, adminOp('cancel')), 'rejected: no pending grid');
  // The last grid stays valid while frozen.
  assert.equal(pay(h, U, deployOp('FROZE'), D), 'accepted');
  // FREEZE also clears a pending operator.
  const k = live();
  assert.equal(gov(k, GUARDIAN, adminOp('setOperator', NEWOP, P(k) + 600)), 'accepted');
  assert.equal(gov(k, SENTINEL, adminOp('freeze')), 'accepted');
  assert.equal(fees(k).pendingOperator, null);
});

test('SET_OPERATOR lifts a freeze after delay; SET_SENTINEL is immediate', () => {
  const h = live();
  assert.equal(gov(h, SENTINEL, adminOp('freeze')), 'accepted');
  // Naming the former operator after a freeze is accepted.
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', OPERATOR, P(h) + 600)), 'accepted');
  const e = P(h) + 600;
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', NEWOP, e)), 'accepted'); // replaces it
  assert.deepEqual(fees(h).pendingOperator, { account: NEWOP, effective: e });
  h.to(e - 1);
  assert.equal(gov(h, NEWOP, feeRateOp(P(h) + 600, 12_500_000_000n)), 'rejected: fee operator frozen');
  // In the promotion block the new operator already acts.
  assert.equal(gov(h, NEWOP, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
  assert.equal(h.height(), e);
  assert.equal(fees(h).operator, NEWOP);
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'rejected: not the fee operator');
  assert.equal(gov(h, GUARDIAN, adminOp('setSentinel', NEWS)), 'accepted');
  assert.equal(fees(h).sentinel, NEWS);
  assert.equal(gov(h, SENTINEL, adminOp('cancel')), 'rejected: not a fee role');
  assert.equal(gov(h, NEWS, adminOp('cancel')), 'accepted');
  assert.equal(gov(h, NEWS, adminOp('setSentinel', SENTINEL)), 'rejected: not the fee guardian');
});

test('SET_GUARDIAN rotates after guardianDelay; naming the guardian aborts', () => {
  const h = live({ guardianDelay: 700 });
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', NEWG, P(h) + 699)), 'rejected: invalid effective height');
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', NEWG, P(h) + 1401)), 'rejected: invalid effective height');
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', NEWG, P(h) + 700)), 'accepted');
  // Abort with a pending guardian, with an effective that is not checked.
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', GUARDIAN, 0)), 'accepted');
  assert.equal(fees(h).pendingGuardian, null);
  // Abort with none: accepted, and the sequence advances.
  const seq = h.seq(GUARDIAN);
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', GUARDIAN, 0xffffffff)), 'accepted');
  assert.equal(h.seq(GUARDIAN), seq + 1n);
  assert.equal(gov(h, OPERATOR, adminOp('setGuardian', GUARDIAN, 0)), 'rejected: not the fee guardian');
  const e = P(h) + 700;
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', NEWG, e)), 'accepted');
  h.to(e);
  h.block();
  assert.equal(fees(h).guardian, NEWG);
  assert.equal(gov(h, GUARDIAN, adminOp('setSentinel', NEWS)), 'rejected: not the fee guardian');
  assert.equal(gov(h, NEWG, adminOp('setSentinel', NEWS)), 'accepted');
});

test('role sets: every excluded account, renaming a pending slot, and the check order', () => {
  const h = live();
  const PO = devAccount('pending-operator'), PG = devAccount('pending-guardian'), X = devAccount('other');
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', PG, P(h) + 600)), 'accepted');
  for (const a of [OPERATOR, GUARDIAN, SENTINEL, PG, ZERO, FEE])
    assert.equal(gov(h, GUARDIAN, adminOp('setOperator', a, P(h) + 600)), 'rejected: invalid fee account role', a);
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', PO, P(h) + 600)), 'accepted');
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', PO, P(h) + 601)), 'accepted'); // renamed
  for (const a of [OPERATOR, SENTINEL, PO, ZERO, FEE])
    assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', a, P(h) + 600)), 'rejected: invalid fee account role', a);
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', PG, P(h) + 601)), 'accepted'); // renamed
  for (const a of [OPERATOR, GUARDIAN, SENTINEL, PO, PG, ZERO, FEE])
    assert.equal(gov(h, GUARDIAN, adminOp('setSentinel', a)), 'rejected: invalid fee account role', a);
  assert.equal(gov(h, GUARDIAN, adminOp('setSentinel', X)), 'accepted');
  // Check order: signer first, then the account, then the effective height.
  // X is the sentinel now.
  assert.equal(gov(h, U, adminOp('setOperator', GUARDIAN, 1)), 'rejected: not the fee guardian');
  assert.equal(gov(h, X, adminOp('setOperator', GUARDIAN, 1)), 'rejected: not the fee guardian');
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', X, 1)), 'rejected: invalid fee account role');
  assert.equal(gov(h, U, adminOp('setGuardian', OPERATOR, 1)), 'rejected: not the fee guardian');
  assert.equal(gov(h, GUARDIAN, adminOp('setSentinel', X)), 'rejected: invalid fee account role');
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', OPERATOR, 1)), 'rejected: invalid fee account role');
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', NEWOP, 1)), 'rejected: invalid effective height');
  // Promotions keep the roles distinct.
  h.to(P(h) + 700);
  assert.equal(fees(h).operator, PO);
  assert.equal(fees(h).guardian, PG);
});

test('a reset at `at` replaces the roles and clears every pending slot', () => {
  const at = 40;
  const h = live({ resets: [{ at, operator: NEWOP, guardian: NEWG, sentinel: NEWS }] });
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', U, P(h) + 600)), 'accepted');
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', V, P(h) + 600)), 'accepted');
  assert.equal(gov(h, SENTINEL, adminOp('freeze')), 'accepted');
  h.to(at);
  h.block([h.remarkTx(OPERATOR, feeRateOp(at + 600, 12_500_000_000n)), h.remarkTx(NEWOP, feeRateOp(at + 600, 12_500_000_000n))]);
  assert.deepEqual(h.results().map((r) => r.verdict), ['rejected: not the fee operator', 'accepted']);
  const f = fees(h);
  assert.deepEqual([f.operator, f.guardian, f.sentinel, f.pendingOperator, f.pendingGuardian, f.nextReset], [NEWOP, NEWG, NEWS, null, null, 1]);
  assert.equal(f.current.rate, R, 'a reset never touches current');
});

// ---------------------------------------------------------------------------- the fee rule
test('BLOCKED symbols are rejected on tags 0, 11 and 12; allowed symbols pay the flat fee', () => {
  for (const kind of ['deploy', 'deployProgressive', 'deployProgressiveV2']) {
    const h = live({}, PROGRESSIVE);
    for (const s of BLOCKED) {
      const r = h.feeTx(U, deployOp(s, kind), D);
      assert.equal(h.one(r), 'rejected: symbol blocked', `${kind} ${s}`);
      assert.equal(h.results()[0].feeKept, true);
    }
    for (const s of ['USDT0', 'WBTC', 'QUANTUS', 'QLYP', 'DOGE', 'PEPE', 'DAI', 'M', 'BTC1', 'ETHS', 'USDCX', 'ABCDEFGHIJKL'])
      assert.equal(pay(h, U, deployOp(s, kind), D), 'accepted', `${kind} ${s}`);
    assert.equal(h.seq(U), 12n);
    // No symbol is priced above the flat fee.
    assert.equal(pay(h, U, deployOp('Q', kind), 10n * D), 'rejected: fee does not match the fee schedule');
    assert.equal(pay(h, U, deployOp('Q', kind), D), 'accepted');
  }
});

test('the fee rule: exact amount, exact shape, exact receipt', () => {
  // legacyBefore false: no legacy window after `from`, so the legacy fee is one more wrong amount.
  const h = live({ legacyBefore: false });
  const op = deployOp('ABC');
  for (const amount of [D + 1n, D - 1n, LEGACY_DEPLOY_FEE, 0n])
    assert.equal(pay(h, U, op, amount), 'rejected: fee does not match the fee schedule', String(amount));
  assert.equal(pay(h, U, op, D, { to: V }), 'rejected: fee batch must be exactly remark_with_event + transfer to Qlyphs');
  assert.equal(pay(h, U, op, D, { calls: (payload) => [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount: D }, { kind: 'pay', to: V, amount: 1n }] }), 'rejected: fee batch must be exactly remark_with_event + transfer to Qlyphs');
  assert.equal(pay(h, U, op, D, { calls: (payload) => [{ kind: 'pay', to: FEE, amount: D }, { kind: 'remark', event: true, payload }] }), 'rejected: fee batch must be exactly remark_with_event + transfer to Qlyphs');
  assert.equal(pay(h, U, op, D, { calls: (payload) => [{ kind: 'remark', event: true, payload }] }), 'rejected: fee batch must be exactly remark_with_event + transfer to Qlyphs');
  assert.equal(pay(h, U, op, D, { calls: (payload) => [{ kind: 'remark', event: false, payload }, { kind: 'pay', to: FEE, amount: D }] }), 'rejected: fee batch must be exactly remark_with_event + transfer to Qlyphs');
  assert.equal(h.one(h.remarkTx(U, op)), 'rejected: deploy/mint requires the Qlyphs fee batch');
  assert.equal(h.one(h.remarkTx(U, inscribeOp())), 'rejected: inscribe requires the Qlyphs fee batch');
  assert.equal(pay(h, U, op, D, { events: [{ kind: 'remarked', sender: U }, { kind: 'paid', from: U, to: FEE, amount: D - 1n }, { kind: 'batchCompleted' }] }), 'rejected: fee batch receipt does not show the paid Qlyphs fee');
  assert.equal(pay(h, U, op, D, { events: [{ kind: 'remarked', sender: U }, { kind: 'paid', from: U, to: FEE, amount: D }] }), 'rejected: fee batch receipt does not show the paid Qlyphs fee');
  assert.equal(h.seq(U), 0n);
  assert.equal(pay(h, U, op, D), 'accepted');
});

test('no fee check reads a role: role accounts pay fees; a role set before a user operation', () => {
  const h = live();
  const PO = devAccount('pending-operator'), PG = devAccount('pending-guardian');
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', PO, P(h) + 600)), 'accepted');
  assert.equal(gov(h, GUARDIAN, adminOp('setGuardian', PG, P(h) + 600)), 'accepted');
  for (const [i, a] of [OPERATOR, SENTINEL, GUARDIAN, PO, PG].entries())
    assert.equal(pay(h, a, deployOp('ROLE' + i), D), 'accepted');
  // SET_OPERATOR names a user in the block before that user's fee operation.
  assert.equal(gov(h, GUARDIAN, adminOp('setOperator', U, P(h) + 600)), 'accepted');
  assert.equal(pay(h, U, deployOp('USER'), D), 'accepted');
});

test('before from: the legacy window with legacyBefore, nothing without it', () => {
  const on = harness(rulesWith(feeRules()));
  on.to(9);
  assert.equal(pay(on, U, deployOp('OLD'), LEGACY_DEPLOY_FEE), 'accepted'); // block 9
  on.block([on.feeTx(V, deployOp('NEW'), D)]); // block 10, from
  assert.equal(on.results()[0].verdict, 'accepted');
  const beforeOn = harness(rulesWith(feeRules()));
  beforeOn.to(9);
  assert.equal(pay(beforeOn, U, deployOp('NEW'), D), 'rejected: fee batch must be exactly remark_with_event + transfer of the exact fee to Qlyphs');
  on.to(10 + 384 - 1);
  assert.equal(pay(on, U, inscribeOp(), LEGACY_INSCRIBE_FEE), 'accepted'); // from + grace - 1
  assert.equal(pay(on, U, inscribeOp('0x02'), LEGACY_INSCRIBE_FEE), 'rejected: fee does not match the fee schedule'); // from + grace
  const off = harness(rulesWith(feeRules({ legacyBefore: false })));
  off.to(9);
  off.block([off.feeTx(U, deployOp('OLD'), LEGACY_DEPLOY_FEE), off.feeTx(V, deployOp('NEW'), D)]);
  assert.deepEqual(off.results(), [
    { index: 0, verdict: 'rejected: fee schedule not active', feeKept: true },
    { index: 1, verdict: 'rejected: fee schedule not active', feeKept: true },
  ]);
  // The legacy window does not exist without legacyBefore.
  off.to(10);
  off.block();
  assert.equal(pay(off, U, deployOp('NEW'), LEGACY_DEPLOY_FEE), 'rejected: fee does not match the fee schedule');
});

test('MINT keeps its fixed fee at every rate, during an overlap and without a schedule', () => {
  const check = (h, deployFee) => {
    assert.equal(pay(h, U, deployOp('MNT'), deployFee), 'accepted');
    const asset = assetId(U, 0n);
    for (const amount of [1_000_000_000n, 20_000_000_000n])
      assert.equal(pay(h, V, { kind: 'mint', asset, amount: 1n }, amount), 'rejected: fee batch must be exactly remark_with_event + transfer of the exact fee to Qlyphs');
    assert.equal(pay(h, V, { kind: 'mint', asset, amount: 1n }, MINT_FEE, { events: [{ kind: 'remarked', sender: V }, { kind: 'paid', from: V, to: FEE, amount: MINT_FEE - 1n }, { kind: 'batchCompleted' }] }), 'rejected: fee batch receipt does not show the exact Qlyphs fee');
    assert.equal(pay(h, V, { kind: 'mint', asset, amount: 1n }, MINT_FEE), 'accepted');
  };
  for (const rate of [RATE_MIN, R, RATE_MAX]) check(live({ rate: String(rate) }), fee(deployOp('MNT'), rate));
  const overlap = live();
  assert.equal(gov(overlap, OPERATOR, feeRateOp(P(overlap) + 600, 12_500_000_000n)), 'accepted');
  overlap.to(P(overlap) + 600);
  assert.notEqual(fees(overlap).previous, null);
  check(overlap, D);
  check(harness(LEGACY_RULES), LEGACY_DEPLOY_FEE);
});

test('mainnet without a schedule reads the legacy fees, as before the fee schedule existed', () => {
  const h = unactivated.harness.harness(LEGACY_RULES, MAINNET, { height: 102_161, hash: id(0x1021) });
  // Contract change (fees-1): shipping the reader without a reviewed schedule must
  // not change how mainnet reads anything, so the legacy exact fees are read there, as before.
  const exact = 'rejected: fee batch must be exactly remark_with_event + transfer of the exact fee to Qlyphs';
  for (const [op, amount, verdict] of [
    [deployOp('ABC'), LEGACY_DEPLOY_FEE, 'accepted'],
    [inscribeOp(), LEGACY_INSCRIBE_FEE, 'accepted'],
    [deployOp('USDT'), LEGACY_DEPLOY_FEE, 'accepted'], // no blocked symbols before the schedule
    [deployOp('DEF'), D, exact],
    [inscribeOp(), LEGACY_DEPLOY_FEE, exact],
  ]) {
    h.block([h.feeTx(U, op, amount)]);
    assert.deepEqual(h.results(), [{ index: 0, verdict, feeKept: verdict !== 'accepted' }]);
  }
  h.block([h.feeTx(U, { kind: 'mint', asset: assetId(V, 0n), amount: 1n }, MINT_FEE)]);
  assert.deepEqual(h.results(), [{ index: 0, verdict: 'rejected: unknown asset', feeKept: true }]);
  assert.equal(h.state().assets.size, 3);
  assert.equal(h.seq(U), 3n);
  assert.equal(h.state().fees, null);
  assert.equal(pay(h, U, deployOp('GHI'), LEGACY_DEPLOY_FEE, { to: V }), exact);
});

test('fee kept: a front-run DEPLOY keeps its fee; a native failure pays nothing', () => {
  const h = live();
  h.block([h.feeTx(U, deployOp('RACE'), D), h.feeTx(V, deployOp('RACE'), D)]);
  assert.deepEqual(h.results(), [
    { index: 0, verdict: 'accepted', feeKept: false },
    { index: 1, verdict: 'rejected: symbol taken', feeKept: true },
  ]);
  h.block([h.feeTx(W, deployOp('FAIL'), D, { success: false, events: [] })]);
  assert.deepEqual(h.results(), [{ index: 0, verdict: 'rejected: fee batch failed', feeKept: false }]);
  // A rejected governance or transfer operation carries no fee.
  h.block([h.remarkTx(U, adminOp('cancel'))]);
  assert.deepEqual(h.results(), [{ index: 0, verdict: 'rejected: not a fee role', feeKept: false }]);
});

test('governance needs a direct remark_with_event of its signer', () => {
  const h = live();
  let op = feeRateOp(P(h) + 600, 12_500_000_000n);
  const verdict = 'rejected: fee schedule requires a direct remark_with_event';
  assert.equal(h.one(h.remarkTx(OPERATOR, op, { wrap: (payload) => ({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount: 0n }] }) })), verdict);
  assert.equal(h.one(h.remarkTx(OPERATOR, adminOp('freeze'), { wrap: (payload) => ({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }] }) })), verdict);
  const ms = id(0x3333);
  assert.equal(h.one(h.remarkTx(SENTINEL, adminOp('freeze'), { wrap: (payload) => ({ kind: 'propose', multisig: ms, call: { kind: 'remark', event: false, payload }, expiry: 1000 }), events: [{ kind: 'created', multisig: ms, proposal: 0, proposer: SENTINEL }] })), verdict);
  assert.equal(h.one(h.remarkTx(OPERATOR, op, { events: [] })), verdict);
  assert.equal(h.one(h.remarkTx(OPERATOR, op, { events: [{ kind: 'remarked', sender: U }] })), verdict);
  assert.equal(h.one(h.remarkTx(OPERATOR, op, { events: [{ kind: 'remarked', sender: OPERATOR }, { kind: 'remarked', sender: OPERATOR }] })), verdict);
  assert.equal(h.seq(OPERATOR), 0n);
  assert.equal(fees(h).operator, OPERATOR);
  op = feeRateOp(P(h) + 600, 12_500_000_000n);
  assert.equal(gov(h, OPERATOR, op), 'accepted');
  // Wrong genesis and sequence are the generic envelope checks, after the context.
  assert.equal(h.one(h.remarkTx(OPERATOR, adminOp('cancel'), { seq: 5n })), 'rejected: wrong/exhausted sequence');
});

test('tags 13 and 14 before from are unknown operations; tag 15 is reserved', () => {
  const h = harness(rulesWith(feeRules()));
  h.to(9);
  h.block([h.remarkTx(OPERATOR, feeRateOp(700, 12_500_000_000n)), h.remarkTx(SENTINEL, adminOp('freeze'))]);
  assert.deepEqual(h.results().map((r) => r.verdict), ['rejected: unknown operation', 'rejected: unknown operation']);
  const payload = hex(encode({ genesis: DEV_GENESIS, sequence: 0n, op: adminOp('cancel') }).slice(0, 46));
  const reserved = payload.slice(0, -2) + '0f';
  assert.equal(h.one({ signer: U, callHex: hex(callBytes({ kind: 'remark', event: true, payload: reserved })), success: true, events: [{ kind: 'remarked', sender: U }] }), 'rejected: reserved operation');
});

// --------------------------------------------------------------------------------- clients
test('parseCommand refuses governance operations; buildCall gates', () => {
  assert.throws(() => parseCommand({ kind: 'feeRate', effective: 1, rate: '10000000000' }), /unsupported command/);
  assert.throws(() => parseCommand({ kind: 'feeAdmin', action: 'freeze' }), /unsupported command/);
  assert.throws(() => buildCall(DEV_GENESIS, U, 0n, feeRateOp(700, R)), /governance operations are not wallet commands/);
  assert.throws(() => buildCall(DEV_GENESIS, U, 0n, adminOp('freeze')), /governance operations are not wallet commands/);
  assert.throws(() => buildCall(DEV_GENESIS, U, 0n, deployOp('ABC')), /fee schedule required/);
  for (const s of BLOCKED)
    for (const kind of ['deploy', 'deployProgressive', 'deployProgressiveV2'])
      assert.throws(() => buildCall(DEV_GENESIS, U, 0n, deployOp(s, kind), undefined, undefined, { rate: R }), /symbol blocked/);
  // No Qlyphs client signs a rate-derived operation on mainnet before the reviewed activation; the
  // release that pins it signs them, at the basis of the state they are priced at.
  for (const op of [deployOp('ABC'), inscribeOp(), deployOp('ABC', 'deployProgressiveV2')])
    for (const basis of [{ rate: R }, { legacy: true }]) {
      assert.throws(() => unactivated.lib.buildCall(MAINNET, U, 0n, op, undefined, undefined, basis), /^Error: QLYP fees are not active on mainnet yet\.$/);
      assert.doesNotThrow(() => buildCall(MAINNET, U, 0n, op, undefined, undefined, basis));
    }
  assert.equal(parseCall(buildCall(MAINNET, U, 0n, { kind: 'mint', asset: assetId(V, 0n), amount: 1n })).calls[1].amount, MINT_FEE);
  assert.equal(parseCall(buildCall(DEV_GENESIS, U, 0n, deployOp('ABC'), undefined, undefined, { rate: R })).calls[1].amount, D);
  assert.equal(parseCall(buildCall(DEV_GENESIS, U, 0n, inscribeOp(), undefined, undefined, { legacy: true })).calls[1].amount, LEGACY_INSCRIBE_FEE);
  assert.equal(qlyphsFee({ kind: 'mint', asset: assetId(V, 0n), amount: 1n }, undefined, { rate: RATE_MAX }), MINT_FEE);
  assert.throws(() => qlyphsFee(inscribeOp()), /fee schedule required/);
});

test('preflight prices at the state, flags the deploy race and refuses what no wallet signs', () => {
  const rules = rulesWith(feeRules());
  const h = live();
  const p = preflight(h.state(), DEV_GENESIS, U, deployOp('ABC'), rules);
  assert.deepEqual({ ...p, call: hex(p.call) }, { call: hex(buildCall(DEV_GENESIS, U, 0n, deployOp('ABC'), undefined, undefined, { rate: R })), fee: D, symbolClass: 'allowed', raceWarning: true });
  for (const kind of ['deployProgressive', 'deployProgressiveV2']) {
    const k = live({}, PROGRESSIVE);
    const q = preflight(k.state(), DEV_GENESIS, U, deployOp('ABC', kind), rulesWith(feeRules(), PROGRESSIVE));
    assert.deepEqual([q.fee, q.symbolClass, q.raceWarning], [D, 'allowed', true]);
  }
  const i = preflight(h.state(), DEV_GENESIS, U, inscribeOp(), rules);
  assert.deepEqual([i.fee, i.symbolClass, i.raceWarning], [D, null, false]);
  assert.throws(() => preflight(h.state(), DEV_GENESIS, U, deployOp('USDT'), rules), /symbol blocked/);
  // The basis is the state's own grid, also while a new grid is pending or once it is promoted.
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
  assert.equal(preflight(h.state(), DEV_GENESIS, U, deployOp('ABC'), rules).fee, D);
  assert.deepEqual(feeBasis(h.state(), rules, DEV_GENESIS), { rate: R });
  h.to(P(h) + 600);
  assert.equal(preflight(h.state(), DEV_GENESIS, U, deployOp('ABC'), rules).fee, 312_500_000_000n);
  // Before from: legacy fees with legacyBefore, a refusal without.
  const before = harness(rules); before.to(9);
  assert.deepEqual(feeBasis(before.state(), rules, DEV_GENESIS), { legacy: true });
  assert.equal(preflight(before.state(), DEV_GENESIS, U, deployOp('ABC'), rules).fee, LEGACY_DEPLOY_FEE);
  const strict = rulesWith(feeRules({ legacyBefore: false }));
  assert.throws(() => preflight(before.state(), DEV_GENESIS, U, deployOp('ABC'), strict), /^Error: fee schedule not active$/);
  assert.throws(() => feeBasis(before.state(), strict, DEV_GENESIS), /^Error: fee schedule not active$/);
  // Mainnet: refused before the reviewed activation; MINT is unaffected by the gate.
  const m = unactivated.harness.harness(LEGACY_RULES, MAINNET, { height: 102_161, hash: id(0x1021) });
  assert.throws(() => unactivated.lib.preflight(m.state(), MAINNET, U, deployOp('ABC')), /^Error: QLYP fees are not active on mainnet yet\.$/);
  assert.throws(() => unactivated.lib.preflight(m.state(), MAINNET, U, inscribeOp()), /^Error: QLYP fees are not active on mainnet yet\.$/);
  assert.throws(() => unactivated.lib.feeBasis(m.state(), LEGACY_RULES, MAINNET), /^Error: QLYP fees are not active on mainnet yet\.$/);
  assert.throws(() => unactivated.lib.preflight(m.state(), MAINNET, U, { kind: 'mint', asset: assetId(V, 0n), amount: 1n }), /unknown asset/);
  // Without a schedule on a development network, the legacy fees.
  const dev = harness(LEGACY_RULES);
  assert.equal(preflight(dev.state(), DEV_GENESIS, U, inscribeOp()).fee, LEGACY_INSCRIBE_FEE);
});

test('governancePreflight runs the reducer checks at the next block; feeGovernanceCall is a direct remark', () => {
  const rules = rulesWith(feeRules());
  const h = live();
  const op = feeRateOp(P(h) + 600, 12_500_000_000n);
  const call = governancePreflight(h.state(), DEV_GENESIS, OPERATOR, op, rules);
  assert.equal(hex(call), hex(feeGovernanceCall(DEV_GENESIS, OPERATOR, 0n, op)));
  assert.deepEqual(parseCall(call), { kind: 'remark', event: true, payload: hex(encode({ genesis: DEV_GENESIS, sequence: 0n, op })) });
  assert.throws(() => governancePreflight(h.state(), DEV_GENESIS, U, op, rules), /not the fee operator/);
  assert.throws(() => governancePreflight(h.state(), DEV_GENESIS, OPERATOR, feeRateOp(P(h) + 599, 12_500_000_000n), rules), /invalid effective height/);
  assert.throws(() => governancePreflight(h.state(), DEV_GENESIS, SENTINEL, adminOp('cancel'), rules), /no pending grid/);
  assert.throws(() => governancePreflight(h.state(), DEV_GENESIS, OPERATOR, op, LEGACY_RULES), /fee schedule not active/);
  // The state is not changed by a preflight.
  assert.equal(fees(h).pending, null);
  assert.equal(h.one({ signer: OPERATOR, callHex: hex(call), success: true, events: [{ kind: 'remarked', sender: OPERATOR }] }), 'accepted');
  // The check runs at the next block: a grid effective there is already promoted.
  const before = harness(rules); before.to(10); // the next block is `from`
  assert.doesNotThrow(() => governancePreflight(before.state(), DEV_GENESIS, SENTINEL, adminOp('freeze'), rules));
  const early = harness(rules); early.to(9);
  assert.throws(() => governancePreflight(early.state(), DEV_GENESIS, SENTINEL, adminOp('freeze'), rules), /fee schedule not active/);
  assert.throws(() => feeGovernanceCall(DEV_GENESIS, ZERO, 0n, adminOp('freeze')), /zero account/);
});

test('feeScheduleView: grids, fees and modes for display', () => {
  const rules = rulesWith(feeRules());
  const h = live();
  assert.equal(gov(h, OPERATOR, feeRateOp(P(h) + 600, 12_500_000_000n)), 'accepted');
  const v = feeScheduleView(h.state(), rules, DEV_GENESIS);
  assert.deepEqual(v, {
    height: 11, hash: h.state().hash, mode: 'schedule', from: 10,
    current: { id: 0, rate: '10000000000', effective: 10, height: 10, index: GENESIS_GRID_INDEX },
    previous: null,
    pending: { id: 1, rate: '12500000000', effective: 611, height: 11, index: 0 },
    frozen: false,
    fees: { deploy: '250000000000', inscribe: '250000000000', mint: '10000000000' },
    pendingFees: { deploy: '312500000000', inscribe: '312500000000' },
  });
  assert.equal(JSON.stringify(v), JSON.stringify(JSON.parse(JSON.stringify(v))));
  const before = harness(rules); before.to(9);
  assert.deepEqual(feeScheduleView(before.state(), rules, DEV_GENESIS).fees, { deploy: '1000000000000', inscribe: '100000000000', mint: '10000000000' });
  const m = unactivated.harness.harness(LEGACY_RULES, MAINNET, { height: 102_161, hash: id(0x1021) });
  const mv = unactivated.lib.feeScheduleView(m.state(), LEGACY_RULES, MAINNET);
  assert.deepEqual([mv.mode, mv.from, mv.fees, mv.current, mv.frozen], ['inactive', null, null, null, false]);
  assert.equal(gov(h, SENTINEL, adminOp('freeze')), 'accepted');
  assert.equal(feeScheduleView(h.state(), rules, DEV_GENESIS).frozen, true);
});

test('feeKept is false for accepted, unsigned, failed or fee-less operations', () => {
  const rules = rulesWith(feeRules());
  const h = live();
  const r = h.feeTx(U, deployOp('ABC'), D);
  assert.equal(feeKept(r, 'accepted', rules, 11), false);
  assert.equal(feeKept(r, 'rejected: symbol taken', rules, 11), true);
  assert.equal(feeKept(r, null, rules, 11), false);
  assert.equal(feeKept({ ...r, signer: null }, 'rejected: symbol taken', rules, 11), false);
  assert.equal(feeKept({ ...r, success: false }, 'rejected: fee batch failed', rules, 11), false);
  assert.equal(feeKept({ ...r, events: r.events.filter((e) => e.kind !== 'paid') }, 'rejected: x', rules, 11), false);
  assert.equal(feeKept({ ...r, events: r.events.map((e) => (e.kind === 'paid' ? { ...e, to: V } : e)) }, 'rejected: x', rules, 11), false);
  assert.equal(feeKept(h.remarkTx(U, { kind: 'transfer', asset: assetId(U, 0n), amount: 1n, to: V }), 'rejected: insufficient available tokens', rules, 11), false);
  assert.equal(feeKept({ ...r, callHex: '0x00' }, 'rejected: x', rules, 11), false);
});

test('a fee operation never reaches an invariant failure: checkFeeState guards the state', async () => {
  const { checkFeeState, genesisFeeState } = await import('../src/fee-schedule.ts');
  const g = genesisFeeState(feeRules());
  assert.doesNotThrow(() => checkFeeState(g, 10, 384));
  for (const bad of [
    { ...g, operator: GUARDIAN },
    { ...g, sentinel: ZERO },
    { ...g, guardian: FEE },
    { ...g, pendingOperator: { account: SENTINEL, effective: 20 } },
    { ...g, pending: { ...g.current, id: 1, effective: 10 } },
    { ...g, pending: { ...g.current, id: 1, effective: 20, rate: 12_340_000_000n } },
    { ...g, nextGrid: 0 },
    { ...g, current: { ...g.current, rate: 1n } },
  ])
    assert.throws(() => checkFeeState(bad, 10, 384), /fee state invariant/);
  const withPrevious = { ...g, previous: { ...g.current }, current: { ...g.current, id: 1, effective: 600 }, nextGrid: 2 };
  assert.doesNotThrow(() => checkFeeState(withPrevious, 983, 384));
  assert.throws(() => checkFeeState(withPrevious, 984, 384), /fee state invariant/);
  assert.doesNotThrow(() => checkFeeState(withPrevious, 984));
});

// ---------------------------------------------------------------------------------- u32 bounds
const LAST_GRID_ID = 0xfffffffe; // nextGrid is a u32 too, so the last id leaves it at 0xffffffff
/** An indexer restored from `h` at its height with `nextGrid` moved, and a block builder for it. */
function restoredAt(h, nextGrid) {
  const s = h.state();
  s.fees.nextGrid = nextGrid;
  const x = NativeIndexer.fromCheckpoint(DEV_GENESIS, s, false, h.rules);
  let n = 0n;
  const block = (receipts) => {
    const t = x.state();
    n++;
    const b = {
      height: t.height + 1, hash: id(0xe0000000n + n * 0x100n), parent: t.hash, spec: 152, txVersion: 6, finalized: t.height + 1,
      receipts: receipts.map((r, index) => ({ hash: id(0xe0000000n + n * 0x100n + BigInt(index) + 1n), ...r, index })),
    };
    x.apply(b);
    return b.receipts.map((r) => x.state().journal.find((e) => e.height === b.height && e.index === r.index)?.verdict);
  };
  return { x, block, seq: (a) => x.state().sequences.get(a) ?? 0n };
}

test('FEE_RATE: the last grid id is allocated, the next is refused cleanly and replay goes on', async () => {
  const { applyFeeRate, checkFeeState, genesisFeeState } = await import('../src/fee-schedule.ts');
  const rules = feeRules();
  const g = { ...genesisFeeState(rules), nextGrid: LAST_GRID_ID };
  const op = feeRateOp(10 + 600, 11_000_000_000n);
  const last = applyFeeRate(g, rules, OPERATOR, op, 10, 3);
  assert.deepEqual(last.pending, { id: LAST_GRID_ID, rate: 11_000_000_000n, effective: 610, height: 10, index: 3 });
  assert.equal(last.nextGrid, 0xffffffff);
  assert.doesNotThrow(() => checkFeeState(last, 10, rules.grace));
  const before = structuredClone(last);
  assert.throws(() => applyFeeRate(last, rules, OPERATOR, op, 10, 4), /^Error: grid ids exhausted$/);
  assert.deepEqual(last, before);
  // The exhaustion check comes last: earlier verdicts keep their order.
  assert.throws(() => applyFeeRate({ ...last, operator: null }, rules, OPERATOR, op, 10, 4), /fee operator frozen/);
  assert.throws(() => applyFeeRate(last, rules, GUARDIAN, op, 10, 4), /not the fee operator/);
  assert.throws(() => applyFeeRate(last, rules, OPERATOR, feeRateOp(609, 11_000_000_000n), 10, 4), /invalid effective height/);
  assert.throws(() => applyFeeRate(last, rules, OPERATOR, feeRateOp(610, 20_000_000_000n), 10, 4), /rate step too large/);

  // Through the reducer: the refused FEE_RATE keeps the state and the sequence, the block goes on.
  const c = restoredAt(live(), LAST_GRID_ID - 1);
  const h = harness(rulesWith(feeRules())); // only builds transactions
  const tx = (signer, op, seq) => h.remarkTx(signer, op, { seq });
  const p = c.x.state().height + 1;
  assert.deepEqual(c.block([tx(OPERATOR, feeRateOp(p + 600, 11_000_000_000n), 0n)]), ['accepted']);
  assert.deepEqual(c.block([tx(OPERATOR, feeRateOp(p + 601, 12_000_000_000n), 1n)]), ['accepted']);
  assert.equal(c.x.state().fees.pending.id, LAST_GRID_ID);
  assert.equal(c.x.state().fees.nextGrid, 0xffffffff);
  const kept = c.x.state().fees;
  const deploy = h.feeTx(U, deployOp('ABC'), D, { seq: 0n });
  assert.deepEqual(
    c.block([tx(OPERATOR, feeRateOp(p + 602, 12_000_000_000n), 2n), deploy, tx(OPERATOR, feeRateOp(p + 602, 12_000_000_000n), 2n)]),
    ['rejected: grid ids exhausted', 'accepted', 'rejected: grid ids exhausted'],
  );
  assert.deepEqual(c.x.state().fees, kept);
  assert.equal(c.seq(OPERATOR), 2n);
  assert.equal(c.seq(U), 1n);
  // Governance still works: CANCEL clears the pending grid; a FEE_RATE after it is still refused.
  assert.deepEqual(
    c.block([tx(SENTINEL, adminOp('cancel'), 0n), tx(OPERATOR, feeRateOp(p + 603, 12_000_000_000n), 2n)]),
    ['accepted', 'rejected: grid ids exhausted'],
  );
  assert.equal(c.x.state().fees.pending, null);
});

test('checkFeeRules: every configured height and window from `from` fits the u32 state fields', () => {
  const MAX = 0xffffffff;
  const reset = (at) => ({ at, operator: NEWOP, guardian: NEWG, sentinel: NEWS });
  for (const ok of [
    feeRules({ from: MAX - 2 * 600 }),
    feeRules({ from: 10, guardianDelay: (MAX - 10) / 2 - 0.5 }),
    feeRules({ from: MAX - 2 * 50_400, delay: 7200, grace: 4608, guardianDelay: 50_400 }),
    feeRules({ resets: [reset(MAX)] }),
  ])
    assert.doesNotThrow(() => checkFeeRules(ok), JSON.stringify(ok));
  for (const bad of [
    feeRules({ from: MAX - 2 * 600 + 1 }),
    feeRules({ from: MAX }),
    feeRules({ from: 2 ** 32 }),
    feeRules({ from: 10, guardianDelay: (MAX - 10) / 2 + 0.5 }),
    feeRules({ guardianDelay: 2 ** 31 }),
    feeRules({ guardianDelay: Number.MAX_SAFE_INTEGER }),
    feeRules({ from: MAX - 2 * 50_400 + 1, delay: 7200, grace: 4608, guardianDelay: 50_400 }),
    feeRules({ resets: [reset(MAX + 1)] }),
  ])
    assert.throws(() => checkFeeRules(bad), /invalid fee schedule/, JSON.stringify(bad));
});
