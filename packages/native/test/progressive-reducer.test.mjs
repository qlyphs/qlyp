/** Progressive mint in the QLYP-v1 reducer: activation, one lot per native right, every fee tier,
 * contention, noncanonical use, legacy separation, replay. Receipts are synthetic here: they model
 * the native behaviour that the runtime itself provides. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assetId,
  balanceOf,
  buildCall,
  checkRules,
  LEGACY_DEPLOY_FEE as DEPLOY_FEE,
  encode,
  feeBatchCall,
  callBytes,
  hex,
  LEGACY_RULES,
  MAINNET,
  mainnetRules,
  MAX_U128,
  MINT_FEE,
  mintTicket,
  NativeIndexer,
  parseCommand,
  preflight,
  progressiveLot,
  progressiveLotFee,
  PROGRESSIVE_MINT_TOTAL_FEE,
  PROGRESSIVE_MINT_TOTAL_FEE_V2,
  PROGRESSIVE_MINT_PROFILE,
  PROGRESSIVE_MINT_PROFILE_V2,
  QLYPHS_FEE_ACCOUNT as FEE,
  qlyphsFee,
  readSettlement,
  saleFee,
  settlementCall,
  ticketKey,
  ZERO,
} from '../src/index.ts';

const id = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const G = id(1000), S = id(1), A = id(2), B = id(3), M = id(4);
const RULES = { progressive: { from: 3 }, progressiveV2: null, feeSchedule: null };
let serial = 5000;
function receipt(signer, callHex, events = [], success = true) {
  return { hash: id(++serial), signer, callHex, success, events };
}
function next(x, receipts = [], finalized) {
  const s = x.state();
  const b = {
    height: s.height + 1,
    hash: id(++serial),
    parent: s.hash,
    spec: 152,
    txVersion: 6,
    finalized: finalized ?? s.height + 1,
    receipts: receipts.map((r, index) => ({ ...r, index: r.index ?? index })),
  };
  x.apply(b);
  return b;
}
/** A fee-batched operation exactly as a wallet builds it, with the matching native events. */
function feeOp(seq, op, actor = S, fee = op.kind === 'mint' ? MINT_FEE : DEPLOY_FEE) {
  const events = [{ kind: 'remarked', sender: actor }, { kind: 'paid', from: actor, to: FEE, amount: fee }, { kind: 'batchCompleted' }];
  return receipt(actor, hex(callBytes(feeBatchCall(hex(encode({ genesis: G, sequence: seq, op })), fee))), events);
}
const deployOp = (cap = 1_000_000n, symbol = 'PROG', decimals = 6) => ({ kind: 'deployProgressive', symbol, decimals, cap });
const marker = () => id(++serial);
/** The exact settlement of the current right, with the events the runtime emits for it. */
function settle(x, asset, who = A, lot = progressiveLot(x.state(), G, asset)) {
  return receipt(who, hex(lot.call), [
    { kind: 'multisig', id: marker(), signers: [...lot.ticket.signers], threshold: 2, creator: who, nonce: lot.ticket.nonce },
    { kind: 'paid', from: who, to: FEE, amount: lot.fee },
    { kind: 'batchCompleted' },
  ]);
}
function indexer(rules = RULES) {
  const x = new NativeIndexer(G, { height: 0, hash: G }, true, rules);
  next(x); // height 1
  return x;
}
function deployed(cap = 1_000_000n, rules = RULES) {
  const x = indexer(rules);
  next(x); // height 2
  next(x, [feeOp(0n, deployOp(cap))]); // height 3 (= activation)
  const asset = assetId(S, 0n);
  assert.equal(x.state().journal.at(-1).verdict, 'accepted');
  return { x, asset };
}
const verdict = (x) => x.state().journal.at(-1)?.verdict;

test('rules are explicit and strict; mainnet refuses any progressive activation', () => {
  assert.deepEqual(checkRules({ progressive: null, progressiveV2: null, feeSchedule: null }), LEGACY_RULES);
  assert.deepEqual(checkRules({ progressive: { from: 7 }, progressiveV2: null, feeSchedule: null }), { progressive: { from: 7 }, progressiveV2: null, feeSchedule: null });
  assert.deepEqual(checkRules({ progressive: null, progressiveV2: { from: 9 }, feeSchedule: null }), { progressive: null, progressiveV2: { from: 9 }, feeSchedule: null });
  for (const bad of [null, {}, { progressive: null }, { progressive: { from: 0 }, progressiveV2: null, feeSchedule: null }, { progressive: { from: 1.5 }, progressiveV2: null, feeSchedule: null },
    { progressive: { from: 2 }, progressiveV2: null, feeSchedule: null, x: 1 }, { progressive: { from: 2 }, progressiveV2: null }, { progressive: { from: 2, y: 1 }, progressiveV2: null, feeSchedule: null }, { progressive: '2', progressiveV2: null, feeSchedule: null },
    { progressive: null, progressiveV2: { from: 0 }, feeSchedule: null }, { progressive: null, progressiveV2: '3' }])
    assert.throws(() => checkRules(bad));
  // Mainnet runs the release's rules only: not progressive-1000-v1, not another activation, and no
  // longer the legacy rules once the release pins its activation.
  for (const rules of [{ progressive: { from: 6 }, progressiveV2: null, feeSchedule: null }, { progressive: null, progressiveV2: { from: 6 }, feeSchedule: null }, LEGACY_RULES])
    assert.throws(() => new NativeIndexer(MAINNET, { height: 5, hash: id(9) }, true, rules), /not enabled on mainnet/);
  assert.doesNotThrow(() => new NativeIndexer(MAINNET, { height: 5, hash: id(9) }, true, mainnetRules()));
});

test('activation boundary: tag 11 is an unknown operation before it and a deploy from it on', () => {
  const x = indexer();
  next(x, [feeOp(0n, deployOp())]); // height 2 < from 3
  assert.equal(verdict(x), 'rejected: unknown operation');
  assert.equal(x.state().assets.size, 0);
  assert.equal(x.state().sequences.get(S), undefined);
  next(x, [feeOp(0n, deployOp())]); // height 3
  assert.equal(verdict(x), 'accepted');
  const a = x.state().assets.get(assetId(S, 0n));
  assert.deepEqual(a.definition, { kind: 'deploy', symbol: 'PROG', decimals: 6, cap: 1_000_000n, limit: 1000n, policy: 'progressive' });
  assert.equal(a.minted, 0n);
  assert.deepEqual(a.right, { height: 3, hash: x.state().hash, index: 0 });
  // Without progressive rules the same bytes stay the legacy verdict forever.
  const legacy = indexer(LEGACY_RULES);
  next(legacy); next(legacy, [feeOp(0n, deployOp())]);
  assert.equal(verdict(legacy), 'rejected: unknown operation');
});

/** A tag-11 payload written byte by byte, so that invalid fields reach the reducer. */
function rawDeploy(symbol, decimals, cap) {
  const le = (v, n) => Array.from({ length: n }, (_, i) => ((BigInt(v) >> BigInt(8 * i)) & 255n).toString(16).padStart(2, '0')).join('');
  const sym = Buffer.from(symbol, 'ascii').toString('hex');
  return '0x514c595001' + G.slice(2) + le(0, 8) + '0b' + (symbol.length * 4).toString(16).padStart(2, '0') + sym + le(decimals, 1) + le(cap, 16);
}
function rawFeeOp(payload, actor = S) {
  const events = [{ kind: 'remarked', sender: actor }, { kind: 'paid', from: actor, to: FEE, amount: DEPLOY_FEE }, { kind: 'batchCompleted' }];
  return receipt(actor, hex(callBytes(feeBatchCall(payload, DEPLOY_FEE))), events);
}

test('a progressive deploy validates its profile and shares the symbol namespace', () => {
  const x = indexer();
  next(x);
  assert.equal(rawDeploy('PROG', 6, 1_000_000n), hex(encode({ genesis: G, sequence: 0n, op: deployOp() })));
  for (const [payload, why] of [
    [rawDeploy('PROG', 6, 1_000_001n), 'supply must contain 1000 equal lots'],
    [rawDeploy('PROG', 6, 999n), 'supply must contain 1000 equal lots'],
    [rawDeploy('PROG', 6, 0n), 'amount must be positive'],
    [rawDeploy('PROG', 19, 1000n), 'invalid decimals'],
    [rawDeploy('prog', 6, 1000n), 'invalid symbol'],
  ]) {
    next(x, [rawFeeOp(payload)]);
    assert.equal(verdict(x), 'rejected: ' + why);
    assert.equal(x.state().assets.size, 0);
  }
  next(x, [feeOp(0n, { kind: 'deploy', symbol: 'PROG', decimals: 0, cap: 10n, limit: 10n, policy: 'open' })]);
  assert.equal(verdict(x), 'accepted');
  next(x, [feeOp(1n, deployOp())]);
  assert.equal(verdict(x), 'rejected: symbol taken');
  // Wrong fee: the deploy fee batch must pay exactly DEPLOY_FEE.
  next(x, [feeOp(1n, deployOp(1000n, 'OTHER'), S, MINT_FEE)]);
  assert.match(verdict(x), /^rejected: fee batch/);
  next(x, [feeOp(1n, deployOp(1000n, 'OTHER'))]);
  assert.equal(verdict(x), 'accepted');
});

test('the exact settlement mints one lot to its signer and moves the right to its extrinsic', () => {
  const { x, asset } = deployed();
  const lot = progressiveLot(x.state(), G, asset);
  assert.equal(lot.lot, 1n);
  assert.equal(lot.fee, 100_000_000_000n);
  assert.equal(lot.amount, 1000n);
  next(x, [receipt(B, '0x00', []), settle(x, asset, A)]);
  const s = x.state(), a = s.assets.get(asset);
  assert.equal(verdict(x), 'accepted');
  assert.equal(a.minted, 1000n);
  assert.equal(balanceOf(s, asset, A), 1000n);
  assert.deepEqual(a.right, { height: s.height, hash: s.hash, index: 1 });
  // The ticket is not kept as an ordinary multisig: attested state does not grow with mints.
  assert.equal(s.multisigs.size, 0);
  assert.equal(s.sequences.get(A), undefined);
});

test('two signers race for one right in one block: only the one the runtime executed is credited', () => {
  const { x, asset } = deployed();
  const win = settle(x, asset, A);
  // The runtime refuses the loser's creation: a failed extrinsic without events.
  const lose = { ...receipt(B, win.callHex, [], false), index: 1 };
  next(x, [win, lose]);
  const s = x.state();
  assert.equal(balanceOf(s, asset, A), 1000n);
  assert.equal(balanceOf(s, asset, B), 0n);
  assert.equal(s.journal.at(-1).verdict, 'rejected: progressive mint failed natively; no Qlyphs fee was paid');
  assert.equal(s.journal.at(-2).verdict, 'accepted');
});

test('every lot of every tier costs its fixed fee, 300 QTC in all, and the last lot closes the mint', () => {
  for (const cap of [1000n, 1_000_000n, 21_000_000n, 100_000_000n, (MAX_U128 / 1000n) * 1000n]) {
    const { x, asset } = deployed(cap);
    let total = 0n;
    for (let n = 1n; n <= 1000n; n++) {
      const lot = progressiveLot(x.state(), G, asset);
      assert.equal(lot.lot, n);
      assert.equal(lot.fee, progressiveLotFee(n));
      assert.equal(lot.amount, cap / 1000n);
      total += lot.fee;
      next(x, [settle(x, asset, n % 2n ? A : B)]);
    }
    const a = x.state().assets.get(asset);
    assert.equal(total, PROGRESSIVE_MINT_TOTAL_FEE);
    assert.equal(a.minted, cap);
    assert.equal(a.right, null);
    assert.equal(balanceOf(x.state(), asset, A) + balanceOf(x.state(), asset, B), cap);
    assert.throws(() => progressiveLot(x.state(), G, asset), /all 1000 lots are minted/);
  }
});

test('199 -> 200 -> 201: the lot-200 settlement cannot buy lot 201 at the old price', () => {
  const { x, asset } = deployed();
  for (let n = 0; n < 199; n++) next(x, [settle(x, asset)]);
  const l200 = progressiveLot(x.state(), G, asset);
  assert.equal(l200.lot, 200n);
  assert.equal(l200.fee, 100_000_000_000n);
  next(x, [settle(x, asset, A, l200)]);
  const l201 = progressiveLot(x.state(), G, asset);
  assert.equal(l201.lot, 201n);
  assert.equal(l201.fee, 200_000_000_000n);
  assert.notEqual(hex(l201.call), hex(l200.call));
  // A late signature for lot 200 names a consumed ticket: the runtime fails it before paying.
  next(x, [receipt(B, hex(l200.call), [], false)]);
  assert.equal(verdict(x), 'rejected: progressive mint failed natively; no Qlyphs fee was paid');
  assert.equal(x.state().assets.get(asset).minted, 200_000n);
  next(x, [settle(x, asset, B)]);
  assert.equal(balanceOf(x.state(), asset, B), 1000n);
});

test('noncanonical uses of the current right mint nothing and rotate it; a stale payment pays no Qlyphs fee', () => {
  const variants = {
    'bare creation': (lot, r) => ({ ...r, callHex: '0x1300', events: [r.events[0]] }),
    'wrong amount': (lot, r) => ({ ...r, callHex: hex(settlementCall(lot.ticket, FEE, 1n)), events: [r.events[0], { ...r.events[1], amount: 1n }, r.events[2]] }),
    'wrong recipient': (lot, r) => ({ ...r, callHex: hex(settlementCall(lot.ticket, B, lot.fee)), events: [r.events[0], { ...r.events[1], to: B }, r.events[2]] }),
    'reordered events': (lot, r) => ({ ...r, events: [r.events[1], r.events[0], r.events[2]] }),
    'another creator': (lot, r) => ({ ...r, events: [{ ...r.events[0], creator: B }, r.events[1], r.events[2]] }),
    'extra payment': (lot, r) => ({ ...r, events: [r.events[0], r.events[1], r.events[1], r.events[2]] }),
    'missing completion': (lot, r) => ({ ...r, events: [r.events[0], r.events[1]] }),
    'call bytes differ': (lot, r) => ({ ...r, callHex: r.callHex + '00' }),
    'fee account signs': (lot, r) => ({ ...r, signer: FEE, events: [{ ...r.events[0], creator: FEE }, { ...r.events[1], from: FEE }, r.events[2]] }),
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const { x, asset } = deployed();
    const lot = progressiveLot(x.state(), G, asset);
    next(x, [mutate(lot, settle(x, asset, A, lot))]);
    const s = x.state(), a = s.assets.get(asset);
    assert.equal(a.minted, 0n, name);
    assert.equal(verdict(x), 'rejected: progressive mint right used without its exact settlement; no lot minted', name);
    assert.deepEqual(a.right, { height: s.height, hash: s.hash, index: 0 }, name);
    const fresh = progressiveLot(s, G, asset);
    assert.equal(fresh.lot, 1n, name);
    assert.equal(fresh.fee, lot.fee, name);
    assert.notEqual(hex(fresh.call), hex(lot.call), name);
    // The old right's exact payment now fails natively and costs no Qlyphs fee.
    next(x, [receipt(B, hex(lot.call), [], false)]);
    assert.equal(x.state().assets.get(asset).minted, 0n, name);
    next(x, [settle(x, asset, B)]);
    assert.equal(balanceOf(x.state(), asset, B), 1000n, name);
  }
});

test('one extrinsic using the rights of two assets mints neither and rotates both', () => {
  const x = indexer();
  next(x);
  next(x, [feeOp(0n, deployOp(1_000_000n, 'ONE')), feeOp(1n, deployOp(1_000_000n, 'TWO'))]);
  const one = assetId(S, 0n), two = assetId(S, 1n);
  const a = progressiveLot(x.state(), G, one), b = progressiveLot(x.state(), G, two);
  // The exact settlement of ONE, whose extrinsic also created TWO's ticket (e.g. through a wrapper).
  const r = settle(x, one, A, a);
  r.events.splice(1, 0, { kind: 'multisig', id: marker(), signers: [...b.ticket.signers], threshold: 2, creator: A, nonce: b.ticket.nonce });
  const block = next(x, [r]);
  const s = x.state();
  for (const [asset, lot] of [[one, a], [two, b]]) {
    assert.equal(s.assets.get(asset).minted, 0n);
    assert.deepEqual(s.assets.get(asset).right, { height: block.height, hash: block.hash, index: 0 });
    const fresh = progressiveLot(s, G, asset);
    assert.equal(fresh.lot, 1n);
    assert.notEqual(hex(fresh.call), hex(lot.call));
  }
  assert.deepEqual(
    s.journal.filter((j) => j.height === block.height).map((j) => j.verdict),
    Array(2).fill('rejected: progressive mint right used without its exact settlement; no lot minted'),
  );
  assert.equal(s.multisigs.size, 0);
  // Both assets mint again from their next rights.
  next(x, [settle(x, one, B)]);
  next(x, [settle(x, two, B)]);
  assert.equal(balanceOf(x.state(), one, B) + balanceOf(x.state(), two, B), 2000n);
});

test('a creation matching no current right is an ordinary multisig; its payment mints nothing', () => {
  const { x, asset } = deployed();
  const lot = progressiveLot(x.state(), G, asset);
  // Same signers, another nonce: another multisig address, not the right.
  const other = { ...lot.ticket, nonce: lot.ticket.nonce + 1n };
  next(x, [receipt(A, hex(settlementCall(other, FEE, lot.fee)), [
    { kind: 'multisig', id: M, signers: [...other.signers], threshold: 2, creator: A, nonce: other.nonce },
    { kind: 'paid', from: A, to: FEE, amount: lot.fee },
    { kind: 'batchCompleted' },
  ])]);
  const s = x.state();
  assert.equal(s.assets.get(asset).minted, 0n);
  assert.equal(verdict(x), 'rejected: not the current progressive mint right; no lot minted');
  assert.ok(s.multisigs.has(M));
  assert.deepEqual(progressiveLot(s, G, asset).ticket, lot.ticket);
});

test('a right cannot be used in the block that created it', () => {
  const x = indexer();
  next(x);
  const deploy = feeOp(0n, deployOp());
  const asset = assetId(S, 0n);
  // Build the same-block ticket from a copy that already contains the deploy.
  const probe = NativeIndexer.fromCheckpoint(G, x.state(), true, RULES);
  const b = next(probe, [deploy]);
  const lot = progressiveLot(probe.state(), G, asset);
  const same = { ...settle(probe, asset, A, lot), index: 1 };
  x.apply({ ...b, receipts: [b.receipts[0], same] });
  const s = x.state();
  assert.equal(s.assets.get(asset).minted, 0n);
  assert.deepEqual(s.assets.get(asset).right, { height: s.height, hash: s.hash, index: 0 });
});

test('legacy MINT on a progressive asset and a progressive settlement on a legacy asset both fail', () => {
  const { x, asset } = deployed();
  next(x, [feeOp(1n, { kind: 'mint', asset, amount: 1000n })]);
  assert.equal(verdict(x), 'rejected: progressive assets mint one lot at a time through their native right');
  assert.equal(x.state().assets.get(asset).minted, 0n);
  assert.equal(x.state().sequences.get(S), 1n);
  next(x, [feeOp(1n, { kind: 'deploy', symbol: 'OLD', decimals: 0, cap: 1_000_000n, limit: 1000n, policy: 'open' })]);
  const legacy = assetId(S, 1n);
  // A ticket derived for the legacy asset is nobody's right.
  const fake = mintTicket(G, legacy, 0n, { height: 3, hash: x.state().hash, index: 0 });
  next(x, [receipt(A, hex(settlementCall(fake, FEE, 100_000_000_000n)), [
    { kind: 'multisig', id: marker(), signers: [...fake.signers], threshold: 2, creator: A, nonce: fake.nonce },
    { kind: 'paid', from: A, to: FEE, amount: 100_000_000_000n },
    { kind: 'batchCompleted' },
  ])]);
  assert.equal(x.state().assets.get(legacy).minted, 0n);
  assert.equal(verdict(x), 'rejected: not the current progressive mint right; no lot minted');
  assert.throws(() => progressiveLot(x.state(), G, legacy), /not a progressive asset/);
  // The legacy asset keeps its legacy mint and fee.
  next(x, [feeOp(2n, { kind: 'mint', asset: legacy, amount: 1000n })]);
  assert.equal(verdict(x), 'accepted');
  assert.equal(x.state().assets.get(legacy).minted, 1000n);
});

test('rights are bound to their asset and network: another asset\'s ticket leaves this one untouched', () => {
  const x = indexer();
  next(x);
  next(x, [feeOp(0n, deployOp(1_000_000n, 'ONE')), { ...feeOp(1n, deployOp(1_000_000n, 'TWO')), index: 1 }]);
  const one = assetId(S, 0n), two = assetId(S, 1n);
  const l1 = progressiveLot(x.state(), G, one), l2 = progressiveLot(x.state(), G, two);
  assert.notDeepEqual(l1.ticket.signers, l2.ticket.signers);
  next(x, [settle(x, two, A)]);
  assert.equal(x.state().assets.get(one).minted, 0n);
  assert.deepEqual(progressiveLot(x.state(), G, one).ticket, l1.ticket);
  assert.notDeepEqual(mintTicket(id(77), one, 0n, l1.anchor).signers, l1.ticket.signers);
});

test('a separate QLYP sequence change never invalidates a settlement', () => {
  const { x, asset } = deployed();
  next(x, [settle(x, asset, A)]);
  const lot = progressiveLot(x.state(), G, asset);
  // A transfers tokens (sequence 0 -> 1) before its already signed mint lands.
  const transfer = { kind: 'transfer', asset, amount: 10n, to: B };
  next(x, [receipt(A, hex(callBytes({ kind: 'remark', event: true, payload: hex(encode({ genesis: G, sequence: 0n, op: transfer })) })), [{ kind: 'remarked', sender: A }])]);
  assert.equal(x.state().sequences.get(A), 1n);
  next(x, [settle(x, asset, A, lot)]);
  assert.equal(verdict(x), 'accepted');
  assert.equal(balanceOf(x.state(), asset, A), 1990n);
  assert.equal(x.state().sequences.get(A), 1n);
});

test('the market stays usable while minting is open: offer and purchase of minted lots', () => {
  const { x, asset } = deployed();
  next(x, [settle(x, asset, A)]);
  next(x, [receipt(A, '0x1300', [{ kind: 'multisig', id: M, signers: [A, B].sort(), threshold: 2, creator: A, nonce: 9n }])]);
  const s0 = x.state();
  const offer = { kind: 'offer', asset, amount: 500n, buyer: B, payout: A, price: 10n ** 12n, fee: saleFee(10n ** 12n), feeTo: FEE, expiry: s0.height + 500 };
  const propose = { kind: 'propose', multisig: M, expiry: offer.expiry, call: { kind: 'remark', event: false, payload: hex(encode({ genesis: G, sequence: 0n, op: offer })) } };
  next(x, [receipt(A, hex(callBytes(propose)), [{ kind: 'created', multisig: M, proposal: 0, proposer: A }])]);
  assert.equal(verdict(x), 'accepted');
  assert.equal(balanceOf(x.state(), asset, A), 500n);
  next(x, [settle(x, asset, B)]);
  assert.equal(x.state().assets.get(asset).minted, 2000n);
  const t = x.state().tickets.get(ticketKey(M, 0));
  assert.equal(t.status, 'locked');
});

test('checkpoint restart, detached replay and rollback agree with an uninterrupted run', () => {
  const { x, asset } = deployed();
  // Keep these blocks provisional (finality stays at the deploy) so that they can roll back.
  const fin = x.state().finalized;
  const blocks = [];
  for (let n = 0; n < 5; n++) blocks.push(next(x, [settle(x, asset, n % 2 ? A : B)], fin));
  const mid = x.state();
  // pack/unpack round trip through JSON (bigint and Map aware), like the durable store.
  const pack = (v) => JSON.stringify(v, (_, w) => (typeof w === 'bigint' ? { $n: w.toString() } : w instanceof Map ? { $m: [...w] } : w));
  const unpack = (t) => JSON.parse(t, (_, w) => (w && typeof w === 'object' && '$n' in w ? BigInt(w.$n) : w && typeof w === 'object' && '$m' in w ? new Map(w.$m) : w));
  const restored = NativeIndexer.fromCheckpoint(G, unpack(pack(mid)), false, RULES);
  const more = [];
  for (let n = 0; n < 3; n++) more.push(next(x, [settle(x, asset, A)], fin));
  for (const b of more) restored.apply(b);
  assert.deepEqual(restored.state().assets, x.state().assets);
  assert.deepEqual(restored.state().balances, x.state().balances);
  // Provisional blocks roll back to the exact right they had.
  const back = blocks[4];
  x.rollback(back.height, back.hash);
  assert.deepEqual(x.state().assets.get(asset), mid.assets.get(asset));
  assert.throws(() => NativeIndexer.fromCheckpoint(G, mid, false, LEGACY_RULES), /progressive rules required/);
});

test('invariants refuse a corrupt progressive checkpoint', () => {
  const { x, asset } = deployed();
  next(x, [settle(x, asset, A)]);
  const cases = [
    (s) => { s.assets.get(asset).right = null; },
    (s) => { s.assets.get(asset).definition.limit = 999n; },
    (s) => { s.assets.get(asset).right.height = s.height + 1; },
    (s) => { s.assets.get(asset).right.index = -1; },
    (s) => { s.assets.get(asset).minted = 1500n; s.balances.set(`${asset}:${A}`, 1500n); },
    (s) => { const legacy = [...s.assets.values()].find(() => true); legacy.definition.policy = 'open'; },
  ];
  for (const corrupt of cases) {
    const s = x.state();
    corrupt(s);
    assert.throws(() => NativeIndexer.fromCheckpoint(G, s, false, RULES));
  }
});

test('commands: parse, fee, build and preflight fail closed', () => {
  assert.deepEqual(parseCommand({ kind: 'mintProgressive', asset: assetId(S, 0n), lot: 1 }), { kind: 'mintProgressive', asset: assetId(S, 0n), lot: 1 });
  for (const lot of [0, 1001, 1.5, '1', -1]) assert.throws(() => parseCommand({ kind: 'mintProgressive', asset: assetId(S, 0n), lot }));
  assert.throws(() => parseCommand({ kind: 'mintProgressive', asset: assetId(S, 0n), lot: 1, fee: '1' }));
  assert.deepEqual(parseCommand({ kind: 'deployProgressive', symbol: 'ABC', decimals: 6, cap: '1000' }), { kind: 'deployProgressive', symbol: 'ABC', decimals: 6, cap: 1000n });
  assert.equal(qlyphsFee({ kind: 'mintProgressive', asset: assetId(S, 0n), lot: 200 }), 100_000_000_000n);
  assert.equal(qlyphsFee({ kind: 'mintProgressive', asset: assetId(S, 0n), lot: 201 }), 200_000_000_000n);
  assert.equal(qlyphsFee({ kind: 'deployProgressive', symbol: 'ABC', decimals: 6, cap: 1000n }, undefined, { legacy: true }), DEPLOY_FEE);
  const { x, asset } = deployed();
  const lot = progressiveLot(x.state(), G, asset);
  const cmd = { kind: 'mintProgressive', asset, lot: 1 };
  assert.equal(hex(buildCall(G, A, 0n, cmd, undefined, lot)), hex(lot.call));
  assert.throws(() => buildCall(G, A, 0n, cmd), /no longer the next lot/);
  assert.throws(() => buildCall(G, A, 0n, { ...cmd, lot: 2 }, undefined, lot), /no longer the next lot/);
  assert.throws(() => buildCall(G, FEE, 0n, cmd, undefined, lot), /fee account cannot mint/);
  assert.throws(() => buildCall(G, A, 0n, { kind: 'deployProgressive', symbol: 'X', decimals: 0, cap: 1001n }), /1000 equal lots/);
  // Preflight: not active, wrong lot, legacy mint of a progressive asset.
  const s = x.state();
  assert.throws(() => preflight(s, G, A, cmd), /not active/);
  assert.equal(hex(preflight(s, G, A, cmd, RULES).call), hex(lot.call));
  // An unfinal right is prepared too: the wallet binds its signature to the attested block instead.
  assert.equal(hex(preflight({ ...s, finalized: s.height - 1 }, G, A, cmd, RULES).call), hex(lot.call));
  assert.throws(() => preflight(s, G, A, { ...cmd, lot: 2 }, RULES), /lot 1 is/);
  assert.throws(() => preflight(s, G, A, { kind: 'mint', asset, amount: 1000n }, RULES), /mint not permitted/);
  assert.throws(() => preflight(s, G, A, { kind: 'deployProgressive', symbol: 'PROG', decimals: 0, cap: 1000n }, RULES), /symbol taken/);
});

test('the settlement reader accepts exactly the settlement shape', () => {
  const t = mintTicket(G, assetId(S, 0n), 5n, { height: 9, hash: id(99), index: 3 });
  const call = settlementCall(t, FEE, 300_000_000_000n);
  assert.deepEqual(readSettlement(call), { ticket: t, to: FEE, amount: 300_000_000_000n });
  for (const bad of [call.slice(0, -1), Uint8Array.of(...call, 0), Uint8Array.of(9, 2, 4, ...call.slice(3)), new Uint8Array()]) assert.equal(readSettlement(bad), null);
  const three = Uint8Array.from(call); three[70] = 3; // first byte of the u32 threshold
  assert.equal(readSettlement(three), null);
});

test('ticket and call bytes match the pinned settlement vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/progressive-settlement.json', import.meta.url), 'utf8'));
  for (const v of vectors) {
    const r = v.right;
    const minted = BigInt(v.state.minted) / (BigInt(v.state.cap) / 1000n);
    const t = mintTicket(v.state.genesis, v.state.asset, minted, r.anchor);
    assert.deepEqual(t.signers, r.signers);
    assert.equal(t.nonce, BigInt(r.nonce));
    assert.equal(hex(settlementCall(t, r.feeTo, BigInt(r.fee))), v.callHex);
  }
});

test('cap and amount bounds hold at the largest divisible u128 supply', () => {
  const cap = (MAX_U128 / 1000n) * 1000n;
  const { x, asset } = deployed(cap);
  // Mint the last lot of a checkpoint that already holds 999 lots.
  const s = x.state(), a = s.assets.get(asset);
  a.minted = cap - cap / 1000n;
  s.balances.set(`${asset}:${A}`, a.minted);
  const y = NativeIndexer.fromCheckpoint(G, s, true, RULES);
  const lot = progressiveLot(y.state(), G, asset);
  assert.equal(lot.lot, 1000n);
  assert.equal(lot.fee, 500_000_000_000n);
  next(y, [settle(y, asset, B, lot)]);
  assert.equal(y.state().assets.get(asset).minted, cap);
  assert.ok(y.state().assets.get(asset).minted <= MAX_U128);
  assert.equal(y.state().assets.get(asset).right, null);
  assert.equal(ZERO.length, 66);
});

test('the package SHA-512 equals OpenSSL on empty, block-boundary and random inputs', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const { sha512 } = await import('../src/sha512.ts');
  const lengths = [0, 1, 3, 55, 56, 63, 64, 111, 112, 113, 127, 128, 129, 239, 240, 255, 256, 1000];
  for (const n of [...lengths, ...Array.from({ length: 64 }, (_, i) => 4 * i + 7)]) {
    const m = randomBytes(n);
    assert.equal(hex(sha512(m)), '0x' + createHash('sha512').update(m).digest('hex'), `length ${n}`);
  }
  assert.equal(hex(sha512(new TextEncoder().encode('abc'))).slice(0, 34), '0xddaf35a193617abacc417349ae204131');
});

test('a creation that lists the ticket signers in the other order still uses the right', () => {
  const { x, asset } = deployed();
  const lot = progressiveLot(x.state(), G, asset);
  const reversed = [lot.ticket.signers[1], lot.ticket.signers[0]];
  next(x, [receipt(B, '0x1300', [{ kind: 'multisig', id: marker(), signers: reversed, threshold: 2, creator: B, nonce: lot.ticket.nonce }])]);
  const s = x.state();
  assert.equal(s.assets.get(asset).minted, 0n);
  assert.deepEqual(s.assets.get(asset).right, { height: s.height, hash: s.hash, index: 0 });
  assert.equal(s.multisigs.size, 0);
  // An exact settlement whose event reports reversed signers is still the exact settlement.
  const fresh = progressiveLot(s, G, asset);
  const r = settle(x, asset, A, fresh);
  r.events[0].signers.reverse();
  next(x, [r]);
  assert.equal(verdict(x), 'accepted');
  assert.equal(balanceOf(x.state(), asset, A), 1000n);
});

test('many rights on one anchor and a flood of creations naming it cost one lookup per event', () => {
  const x = indexer();
  next(x);
  // 300 progressive deploys in one block: all their rights share that block's hash.
  const deploys = Array.from({ length: 300 }, (_, i) => ({ ...feeOp(BigInt(i), deployOp(1000n, 'F' + i), S) }));
  next(x, deploys);
  const anchor = x.state().hash;
  const events = Array.from({ length: 1000 }, (_, i) => ({ kind: 'multisig', id: id(700000 + i), signers: [anchor, id(800000 + i)].sort(), threshold: 2, creator: B, nonce: BigInt(i) }));
  const started = performance.now();
  next(x, [receipt(B, '0x1300', events)]);
  const elapsed = performance.now() - started;
  assert.equal(x.state().multisigs.size, 1000);
  assert.ok(elapsed < 2000, `block took ${Math.round(elapsed)} ms`);
});

test('progressive assets do not make each receipt slower: their invariants run once per block', () => {
  // The best of three blocks of 250 plain receipts, with 600 assets of one kind.
  const blockMs = (op) => {
    const x = indexer();
    next(x);
    for (let i = 0; i < 600; i += 300)
      next(x, Array.from({ length: 300 }, (_, j) => feeOp(0n, op(i + j), id(10_000 + i + j))));
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const receipts = Array.from({ length: 250 }, () => receipt(B, '0x0000'));
      const started = performance.now();
      next(x, receipts);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const legacy = blockMs((i) => ({ kind: 'deploy', symbol: 'L' + i, decimals: 0, cap: 1000n, limit: 1000n, policy: 'open' }));
  const progressive = blockMs((i) => deployOp(1000n, 'P' + i, 0));
  assert.ok(progressive < 3 * legacy + 50, `progressive ${Math.round(progressive)} ms, legacy ${Math.round(legacy)} ms`);
});

test('a checkpoint holding progressive assets needs an activation at or below its height', () => {
  const { x } = deployed();
  const s = x.state();
  assert.throws(() => NativeIndexer.fromCheckpoint(G, s, false, { progressive: { from: s.height + 1 }, progressiveV2: null, feeSchedule: null }), /progressive rules required/);
  assert.doesNotThrow(() => NativeIndexer.fromCheckpoint(G, s, false, { progressive: { from: s.height }, progressiveV2: null, feeSchedule: null }));
});

const V2 = { progressive: null, progressiveV2: { from: 3 }, feeSchedule: null };
const BOTH = { progressive: { from: 3 }, progressiveV2: { from: 3 }, feeSchedule: null };
const deployV2 = (cap = 1_000_000n, symbol = 'LOTS', decimals = 6) => ({ kind: 'deployProgressiveV2', symbol, decimals, cap });

test('progressive-1000-v2 (tag 12): its own activation, each lot at its v2 fee, 210 QTC in all', () => {
  const x = indexer(V2);
  // Height 2, before the v2 activation: tag 12 is an unknown operation.
  next(x, [feeOp(0n, deployV2())]);
  assert.equal(verdict(x), 'rejected: unknown operation');
  // Height 3, the v2 activation: tag 11 stays unknown, since only v2 is active here.
  next(x, [feeOp(0n, deployOp())]);
  assert.equal(verdict(x), 'rejected: unknown operation');
  next(x, [feeOp(0n, deployV2(1000n))]); // height 4
  assert.equal(verdict(x), 'accepted');
  const asset = assetId(S, 0n);
  assert.equal(x.state().assets.get(asset).definition.policy, 'progressive-v2');
  const tiers = [10_000_000_000n, 100_000_000_000n, 200_000_000_000n, 300_000_000_000n, 440_000_000_000n];
  let total = 0n;
  for (let n = 1n; n <= 1000n; n++) {
    const lot = progressiveLot(x.state(), G, asset);
    assert.equal(lot.profile, PROGRESSIVE_MINT_PROFILE_V2);
    assert.equal(lot.lot, n);
    assert.equal(lot.fee, tiers[Number((n - 1n) / 200n)]);
    total += lot.fee;
    next(x, [settle(x, asset, n % 2n ? A : B)]);
  }
  const a = x.state().assets.get(asset);
  assert.equal(total, PROGRESSIVE_MINT_TOTAL_FEE_V2);
  assert.equal(a.minted, 1000n);
  assert.equal(a.right, null);
  // A legacy MINT of a v2 asset is rejected like one of a v1 asset.
  next(x, [feeOp(1n, { kind: 'mint', asset, amount: 1n })]);
  assert.match(verdict(x), /one lot at a time/);
});

test('v1 and v2 rights are separate: a ticket from the other profile is no right', () => {
  const x = indexer(BOTH);
  next(x);
  next(x, [feeOp(0n, deployOp(1000n, 'ONE')), feeOp(1n, deployV2(1000n, 'TWO'))]);
  const one = assetId(S, 0n), two = assetId(S, 1n);
  const right = progressiveLot(x.state(), G, two);
  // The v2 asset's lot, but its ticket named in the v1 domain: an ordinary multisig, nothing minted.
  const wrong = mintTicket(G, two, 0n, right.anchor, PROGRESSIVE_MINT_PROFILE);
  assert.notDeepEqual(wrong.signers, right.ticket.signers);
  next(x, [receipt(A, hex(settlementCall(wrong, FEE, right.fee)), [
    { kind: 'multisig', id: marker(), signers: [...wrong.signers], threshold: 2, creator: A, nonce: wrong.nonce },
    { kind: 'paid', from: A, to: FEE, amount: right.fee },
    { kind: 'batchCompleted' },
  ])]);
  assert.equal(verdict(x), 'rejected: not the current progressive mint right; no lot minted');
  assert.equal(x.state().assets.get(two).minted, 0n);
  assert.deepEqual(progressiveLot(x.state(), G, two).ticket, right.ticket);
  // Both mint through their own rights, each at its own fee.
  next(x, [settle(x, one, A)]);
  next(x, [settle(x, two, B)]);
  assert.equal(balanceOf(x.state(), one, A), 1n);
  assert.equal(balanceOf(x.state(), two, B), 1n);
  assert.equal(progressiveLot(x.state(), G, one).fee, 100_000_000_000n);
  assert.equal(progressiveLot(x.state(), G, two).fee, 10_000_000_000n);
});

test('commands and checkpoints know which profile a token uses', () => {
  const x = indexer(V2);
  next(x);
  next(x, [feeOp(0n, deployV2(1000n))]);
  const asset = assetId(S, 0n), s = x.state(), lot = progressiveLot(s, G, asset);
  assert.deepEqual(parseCommand({ kind: 'deployProgressiveV2', symbol: 'ABC', decimals: 6, cap: '1000' }), { kind: 'deployProgressiveV2', symbol: 'ABC', decimals: 6, cap: 1000n });
  assert.equal(qlyphsFee({ kind: 'deployProgressiveV2', symbol: 'ABC', decimals: 6, cap: 1000n }, undefined, { legacy: true }), DEPLOY_FEE);
  const cmd = parseCommand({ kind: 'mintProgressive', asset, lot: 1, profile: PROGRESSIVE_MINT_PROFILE_V2 });
  assert.equal(qlyphsFee(cmd), 10_000_000_000n);
  assert.equal(qlyphsFee({ kind: 'mintProgressive', asset, lot: 201, profile: PROGRESSIVE_MINT_PROFILE_V2 }), 100_000_000_000n);
  assert.throws(() => parseCommand({ kind: 'mintProgressive', asset, lot: 1, profile: 'progressive-1000-v3' }), /invalid progressive profile/);
  assert.equal(hex(buildCall(G, A, 0n, cmd, undefined, lot)), hex(lot.call));
  // A dapp that priced the lot with the other schedule is refused.
  assert.throws(() => buildCall(G, A, 0n, { kind: 'mintProgressive', asset, lot: 1 }, undefined, lot), /another progressive profile/);
  assert.equal(hex(preflight(s, G, A, cmd, V2).call), hex(lot.call));
  assert.throws(() => preflight(s, G, A, cmd, LEGACY_RULES), /not active/);
  assert.throws(() => preflight(s, G, A, { kind: 'deployProgressiveV2', symbol: 'NEW', decimals: 0, cap: 1000n }, { progressive: { from: 1 }, progressiveV2: null, feeSchedule: null }), /not active/);
  // A checkpoint with a v2 token needs the v2 activation, not the v1 one.
  assert.throws(() => NativeIndexer.fromCheckpoint(G, s, false, { progressive: { from: 1 }, progressiveV2: null, feeSchedule: null }), /progressive rules required/);
  assert.doesNotThrow(() => NativeIndexer.fromCheckpoint(G, s, false, V2));
});
