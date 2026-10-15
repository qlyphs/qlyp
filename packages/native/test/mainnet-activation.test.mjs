import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_RULES,
  MAINNET,
  MAINNET_FEE_SCHEDULE,
  MAINNET_PROGRESSIVE_V2_FROM,
  mainnetReviewed,
  mainnetRules,
  mainnetRulesAllowed,
  NativeIndexer,
} from '../src/protocol.ts';
import { DEVELOPMENT, mainnetProfile, profileRules } from '../src/network.ts';
import { feeRules, mainnetFeeRules } from './helpers/fee-fixtures.mjs';

const id = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const v1 = (from) => ({ progressive: { from }, progressiveV2: null, feeSchedule: null });
const v2 = (from) => ({ progressive: null, progressiveV2: { from }, feeSchedule: null });
const full = (from, fees = mainnetFeeRules(from)) => ({ progressive: null, progressiveV2: { from }, feeSchedule: fees });

test('this release activates progressive-1000-v2 and the fee schedule on mainnet from block 218,350', () => {
  // The reviewed activation. Changing it is a new activation, reviewed and approved again.
  const H = 218_350;
  const fees = mainnetFeeRules(H, {
    operator: '0x1581d983b4e5ea7cdc09e367934cb3ee26668a9812e93c0fb11c233108dae379',
    guardian: '0x58cefd2c30b74c033a3cbb09dbb956aecc55c236df5d5a8d0fdb7be0ec7f41f8',
    sentinel: '0xadadf0774413e40aa14f9b8474cfbb84e59c369cb5aaeb49cc328422b7560feb',
    rate: '12200000000',
  });
  assert.equal(MAINNET_PROGRESSIVE_V2_FROM, H);
  assert.deepEqual(MAINNET_FEE_SCHEDULE, fees);
  assert.equal(mainnetReviewed(), true);
  assert.deepEqual(mainnetRules(), full(H, fees));
  const anchor = { height: 102_161, hash: id(9) };
  assert.doesNotThrow(() => new NativeIndexer(MAINNET, anchor, true, mainnetRules()));
  // A mainnet reader runs these rules by default, and no others.
  assert.deepEqual(new NativeIndexer(MAINNET, anchor).rules, full(H, fees));
  for (const rules of [LEGACY_RULES, v1(6), v2(6), v2(H), full(6), full(H - 1), full(H + 1)])
    assert.throws(() => new NativeIndexer(MAINNET, anchor, true, rules), /not enabled on mainnet/);
});

test('once reviewed, mainnet runs progressive-1000-v2 and the fee schedule from one height', () => {
  const H = 200_000, fees = mainnetFeeRules(H);
  assert.deepEqual(mainnetRules(H, fees), full(H));
  assert.equal(mainnetReviewed(H, fees), true);
  assert.equal(mainnetRulesAllowed(full(H), 102_161, H, fees), true);
  // The activation must come after the block QLYP starts reading on mainnet.
  assert.equal(mainnetRulesAllowed(full(H), H, H, fees), false);
  assert.equal(mainnetRulesAllowed(full(H), H + 1, H, fees), false);
  // Another height, legacy rules, progressive-1000-v1 or another schedule would read paid
  // operations differently.
  for (const rules of [
    full(H - 1),
    full(H + 1),
    full(H, mainnetFeeRules(H, { rate: '20000000000' })),
    v2(H),
    LEGACY_RULES,
    v1(H),
    { progressive: { from: H }, progressiveV2: { from: H }, feeSchedule: fees },
  ])
    assert.equal(mainnetRulesAllowed(rules, 102_161, H, fees), false);
  // Contract change (fees-1): progressive v2 and the fee schedule activate together, at the same
  // height. One pin alone or two heights are refused.
  assert.equal(mainnetRulesAllowed(v2(H), 102_161, H, null), false);
  assert.equal(mainnetReviewed(H, null), false);
  assert.equal(mainnetReviewed(null, fees), false);
  assert.equal(mainnetRulesAllowed(full(H, mainnetFeeRules(H + 1)), 102_161, H, mainnetFeeRules(H + 1)), false);
  assert.equal(mainnetReviewed(H, mainnetFeeRules(H + 1)), false);
  // Contract change (fees-1): the schedule must keep the legacy reading below
  // `from` and for `grace` blocks after it. Without it, merging the pins would change how mainnet
  // reads every rate-derived operation signed under the old rules, so legacyBefore false is refused.
  const strict = mainnetFeeRules(H, { legacyBefore: false });
  assert.equal(mainnetRulesAllowed(full(H, strict), 102_161, H, strict), false);
  // Without reviewed pins, only legacy rules.
  assert.equal(mainnetRulesAllowed(LEGACY_RULES, 102_161, null, null), true);
  assert.equal(mainnetRulesAllowed(v2(H), 102_161, null, null), false);
  assert.equal(mainnetRulesAllowed(full(H), 102_161, null, null), false);
});

test('mainnet takes its rules from the release, never from configured values', () => {
  const pins = mainnetProfile({
    genesis: MAINNET,
    runtime: { specVersion: 153, transactionVersion: 6, codeHash: id(77) },
    activation: { height: 102_161, hash: id(78) },
  });
  assert.deepEqual(profileRules(pins, undefined, undefined, undefined), mainnetRules());
  assert.deepEqual(profileRules(pins, '', '', ''), mainnetRules());
  for (const [from, fromV2] of [
    ['300000', undefined],
    [undefined, '300000'],
    ['1', '1'],
  ])
    assert.throws(() => profileRules(pins, from, fromV2, undefined), /reviewed release only/);
  assert.throws(() => profileRules(pins, undefined, undefined, JSON.stringify(feeRules())), /fee schedule from the reviewed release only/);
  assert.throws(() => profileRules(pins, undefined, undefined, 'null'), /reviewed release only/);
  // Development keeps its configured values.
  assert.deepEqual(profileRules(DEVELOPMENT, undefined, '42', undefined), v2(42));
  assert.deepEqual(profileRules(DEVELOPMENT, undefined, undefined, undefined), LEGACY_RULES);
  assert.deepEqual(
    profileRules(DEVELOPMENT, undefined, '42', JSON.stringify(feeRules())),
    { progressive: null, progressiveV2: { from: 42 }, feeSchedule: feeRules() },
  );
});
