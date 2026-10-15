// The mainnet lock: nothing reads or signs for Quantus mainnet without complete pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVELOPMENT, MAINNET, NativeIndexer, checkManifest, mainnetProfile, buildCall, callBytes, encode, feeBatchCall, feeKept, LEGACY_DEPLOY_FEE, QLYPHS_FEE_ACCOUNT, assetId, hex } from '../src/index.ts';

const h = (b) => '0x' + b.repeat(32);
const pins = {
  genesis: MAINNET,
  runtime: { specVersion: 153, transactionVersion: 6, codeHash: h('78') },
  activation: { height: 120000, hash: h('ab') },
};
const manifest = (over = {}) => ({
  format: 1,
  network: 'mainnet',
  genesis: MAINNET,
  runtimeHash: h('78'),
  activation: { height: 120000, hash: h('ab') },
  ...over,
});

test('mainnet profile needs every pin, a mainnet genesis and an activation after genesis', () => {
  const p = mainnetProfile(pins);
  assert.equal(p.network, 'mainnet');
  assert.deepEqual(p.activation, pins.activation);
  for (const bad of [
    undefined,
    {},
    { ...pins, genesis: h('11') },
    { ...pins, runtime: undefined },
    { ...pins, activation: undefined },
    { ...pins, activation: { height: 0, hash: MAINNET } },
    { ...pins, activation: { height: 1.5, hash: h('ab') } },
    { ...pins, runtime: { ...pins.runtime, codeHash: '0x78' } },
    { ...pins, runtime: { ...pins.runtime, specVersion: '153' } },
  ])
    assert.throws(() => mainnetProfile(bad));
});

test('a manifest must match its profile exactly', () => {
  const p = mainnetProfile(pins);
  checkManifest(manifest(), p);
  assert.throws(() => checkManifest(manifest({ network: 'development' }), p));
  assert.throws(() => checkManifest(manifest({ runtimeHash: h('79') }), p));
  assert.throws(() => checkManifest(manifest({ activation: { height: 120001, hash: h('ab') } }), p));
  // A development build never accepts mainnet, whatever the manifest claims.
  assert.throws(() => checkManifest(manifest(), DEVELOPMENT));
  const dev = h('22');
  checkManifest(
    { format: 1, network: 'development', genesis: dev, runtimeHash: DEVELOPMENT.runtime.codeHash, activation: { height: 0, hash: dev } },
    DEVELOPMENT,
  );
});

test('the engine starts at the excluded activation checkpoint', () => {
  assert.throws(() => new NativeIndexer(MAINNET), /activation/);
  assert.equal(new NativeIndexer(MAINNET, pins.activation).state().height, 120000);
});

// The manifest height is an excluded anchor, including when a valid operation exists there.
// Below the activation height, mainnet reads this legacy-fee DEPLOY exactly as before the fee
// schedule existed, and the release's clients sign it at the legacy basis. The call is built by
// hand here, as a third-party client could.
test('activation is excluded and the next block is the first interpreted block', () => {
  const owner = h('11');
  const indexer = new NativeIndexer(MAINNET, pins.activation);
  const op = { kind: 'deploy', symbol: 'FIRST', decimals: 0, cap: 10n, limit: 1n, policy: 'open' };
  assert.doesNotThrow(() => buildCall(MAINNET, owner, 0n, op, undefined, undefined, { legacy: true }));
  const receipt = {
    index: 0,
    hash: h('22'),
    signer: owner,
    callHex: hex(callBytes(feeBatchCall(hex(encode({ genesis: MAINNET, sequence: 0n, op })), LEGACY_DEPLOY_FEE))),
    success: true,
    events: [
      { kind: 'remarked', sender: owner },
      { kind: 'paid', from: owner, to: QLYPHS_FEE_ACCOUNT, amount: LEGACY_DEPLOY_FEE },
      { kind: 'batchCompleted' },
    ],
  };
  // Receipts use the adapter's normalized runtime version; network pins are checked upstream.
  const block = {
    height: pins.activation.height,
    hash: pins.activation.hash,
    parent: h('33'),
    spec: 152,
    txVersion: 6,
    finalized: pins.activation.height,
    receipts: [receipt],
  };
  assert.throws(() => indexer.apply(block), /noncontiguous/);
  assert.equal(indexer.state().assets.size, 0);
  assert.equal(indexer.state().sequences.size, 0);
  assert.throws(() => indexer.apply({ ...block, height: block.height + 1, hash: h('44') }), /noncontiguous/);
  indexer.apply({ ...block, height: block.height + 1, hash: h('44'), parent: pins.activation.hash });
  const s = indexer.state();
  assert.equal(s.height, pins.activation.height + 1);
  assert.deepEqual(s.journal, [{ height: s.height, index: 0, verdict: 'accepted' }]);
  assert.equal(feeKept(receipt, s.journal[0].verdict, indexer.rules, s.height), false);
  assert.equal(s.assets.has(assetId(owner, 0n)), true);
  assert.equal(s.sequences.get(owner), 1n);
});
