import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeIndexer, MAINNET, ZERO, MAX_U128, MAX_U64, Reader, assetId, balanceOf, buyCall, callBytes, compact, concat, decode, encode, fromHex, hex, parseCall, ticketKey, QLYPHS_FEE_ACCOUNT as FEE, LEGACY_DEPLOY_FEE as DEPLOY_FEE, MINT_FEE, saleFee, buildCall, preflight, qlyphsFee, withSaleFee } from '../src/index.ts';
const id = n => '0x' + n.toString(16).padStart(64, '0');
const G = id(1000), S = id(1), B = id(2), M = id(3), F = id(4);
const A = assetId(S, 0n), K = ticketKey(M, 0);
const deploy = { kind: 'deploy', symbol: 'TEST', decimals: 6, cap: 1000n, limit: 500n, policy: 'issuer' };
const offer = { kind: 'offer', asset: A, amount: 100n, buyer: B, payout: S, price: 10n ** 12n, fee: saleFee(10n ** 12n), feeTo: FEE, expiry: 20 };
const envelope = (sequence, op, genesis = G) => ({ genesis, sequence, op });
const remark = e => ({ kind: 'remark', payload: hex(encode(e)), event: true });
let serial = 9000;
function receipt(signer, call, events = [], success = true, index = 0) {
  return { index, hash: id(++serial), signer, callHex: typeof call === 'string' ? call : hex(callBytes(call)), success, events };
}
function next(x, receipts = [], finalized = x.state().finalized) {
  const s = x.state(); const b = { height: s.height + 1, hash: id(++serial), parent: s.hash, spec: 152, txVersion: 6, finalized, receipts }; x.apply(b); return b;
}
// A development network without a fee schedule reads the legacy fees.
const LEGACY = { legacy: true };
const feeOf = p => (p.kind === 'deploy' ? DEPLOY_FEE : p.kind === 'mint' ? MINT_FEE : 0n);
/** A v1 operation exactly as the wallet builds it: deploy/mint in the fee batch, transfer bare. */
function opReceipt(seq, p, actor = S, genesis = G) {
  const events = [{ kind: 'remarked', sender: actor }];
  if (feeOf(p) > 0n) events.push({ kind: 'paid', from: actor, to: FEE, amount: feeOf(p) }, { kind: 'batchCompleted' });
  return receipt(actor, hex(buildCall(genesis, actor, seq, p, undefined, undefined, LEGACY)), events);
}
function op(x, seq, p, actor = S, genesis = G) { return next(x, [opReceipt(seq, p, actor, genesis)]); }
function fixture(p = offer, finalize = true) {
  const x = new NativeIndexer(G);
  next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [S, B], threshold: 2 }])]);
  op(x, 0n, deploy); op(x, 1n, { kind: 'mint', asset: A, amount: 500n });
  const c = { kind: 'propose', multisig: M, call: { kind: 'remark', event: false, payload: hex(encode(envelope(2n, p))) }, expiry: p.expiry };
  next(x, [receipt(S, c, [{ kind: 'created', multisig: M, proposal: 0, proposer: S }])]);
  if (finalize) next(x, [], 4); return x;
}
function purchase(x) {
  const t = x.state().tickets.get(K); const events = [{ kind: 'approved', multisig: M, proposal: 0, approver: B }, { kind: 'paid', from: B, to: t.offer.payout, amount: t.offer.price }];
  if (t.offer.fee > 0n) events.push({ kind: 'paid', from: B, to: t.offer.feeTo, amount: t.offer.fee });
  events.push({ kind: 'batchCompleted' }); return receipt(B, buyCall(t), events);
}
for (const p of [deploy, { kind: 'mint', asset: A, amount: 1n }, { kind: 'transfer', asset: A, amount: 2n, to: B }, offer]) {
  test(`canonical wire round-trip: ${p.kind}`, () => {
    const e = envelope(3n, p), b = encode(e); assert.deepEqual(decode(b), e);
    assert.equal(hex(b).slice(0, 12), '0x514c595001');
    assert.throws(() => decode(concat(b, Uint8Array.of(0))), /trailing/);
    for (let n = 0; n < b.length; n++) assert.throws(() => decode(b.slice(0, n)));
  });
}
test('fixed asset IDs are creator + little-endian sequence, not a ticker', () => {
  assert.equal(assetId(S, 1n), S + '0100000000000000'); assert.notEqual(assetId(S, 0n), assetId(B, 0n));
});
test('canonical SCALE compact integer boundaries', () => {
  for (const v of [0n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, MAX_U128]) {
    const r = new Reader(compact(v)); assert.equal(r.compact(), v); r.end();
  }
  assert.throws(() => new Reader(Uint8Array.of(1, 0)).compact(), /canonical/);
  assert.throws(() => compact(MAX_U128 + 1n));
});
test('reject malformed and oversized envelopes', () => {
  for (const p of [{ ...deploy, decimals: 19 }, { ...deploy, cap: -1n }, { ...deploy, symbol: 'foo' }, { ...offer, amount: 0n }, { ...offer, price: MAX_U128, fee: 1n }, { ...offer, fee: 0n, feeTo: F }]) assert.throws(() => encode(envelope(0n, p)));
  assert.throws(() => encode(envelope(MAX_U64 + 1n, deploy)));
  assert.throws(() => decode(new Uint8Array(1025)));
  for (const v of [0, 2]) { const b = encode(envelope(0n, deploy)); b[4] = v; assert.throws(() => decode(b), /version/); }
});
test('tags 4..8 are RESERVED for future operations: decode refuses them, the indexer rejects them with no effect', () => {
  const head = hex(encode(envelope(0n, deploy))).slice(0, 2 + 2 * (5 + 32 + 8));
  const asset = A.slice(2), u128 = '00'.repeat(15) + '01';
  // Plausible byte layouts (and a bare tag) for each reserved tag.
  const bodies = { 4: ['0c' + '414243', ''], 5: [asset + u128 + u128, ''], 6: [asset + u128 + u128, ''], 7: ['04' + '00'.repeat(8), ''], 8: [u128, ''] };
  for (const [tag, list] of Object.entries(bodies))
    for (const body of list) {
      const bytes = fromHex(head + Number(tag).toString(16).padStart(2, '0') + body);
      assert.throws(() => decode(bytes), /reserved operation/, `tag ${tag}`);
    }
  for (const tag of [10, 255]) assert.throws(() => decode(fromHex(head + tag.toString(16).padStart(2, '0'))), /unknown operation/);
  for (const kind of ['reserved4', 'reserved5', 'reserved6', 'reserved7', 'reserved8'])
    assert.throws(() => encode(envelope(0n, { kind, symbol: 'ABC', asset: A, qtcIn: 1n, minOut: 0n, tokensIn: 1n, minQtcOut: 0n, payoutIds: [0n], amount: 1n })), /unknown operation/);
  // In the exact DEPLOY fee batch or as a bare remark_with_event: rejected, no sequence advance.
  const x = new NativeIndexer(G); next(x);
  const payload = head + '04' + '0c414243';
  const batch = { kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount: DEPLOY_FEE }] };
  next(x, [receipt(S, batch, [{ kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: DEPLOY_FEE }, { kind: 'batchCompleted' }])]);
  assert.equal(x.state().journal.at(-1).verdict, 'rejected: reserved operation');
  next(x, [receipt(S, { kind: 'remark', event: true, payload: head + '08' + u128 }, [{ kind: 'remarked', sender: S }])]);
  assert.equal(x.state().journal.at(-1).verdict, 'rejected: reserved operation');
  assert.equal(x.state().sequences.get(S), undefined); assert.equal(x.state().assets.size, 0); assert.equal(x.state().symbols.size, 0);
  // No wide (payout-style) batch exists any more: every runtime batch has at most 3 calls.
  const pay = { kind: 'pay', to: B, amount: 1n };
  assert.throws(() => callBytes({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, pay, pay, pay] }), /unsupported batch/);
  assert.throws(() => parseCall(concat(Uint8Array.of(9, 2), compact(4n), ...Array(4).fill(callBytes(pay)))), /batch too large/);
  assert.deepEqual(parseCall(callBytes({ kind: 'batch', calls: [pay, pay, pay] })).calls.length, 3);
});
test('runtime call round-trip and strict no nested batches', () => {
  const x = fixture(); const c = buyCall(x.state().tickets.get(K)); assert.deepEqual(parseCall(callBytes(c)), c);
  assert.throws(() => parseCall(concat(callBytes(c), Uint8Array.of(0))));
  assert.throws(() => parseCall(fromHex('0x090204090200')), /nested/);
});
test('deploy -> mint -> reserve -> buy -> transfer, with supply preserved', () => {
  const x = fixture(); assert.equal(balanceOf(x.state(), A, S), 400n);
  assert.equal(hex(x.prepareBuy(K, B)), hex(callBytes(buyCall(x.state().tickets.get(K)))));
  next(x, [purchase(x)]); assert.equal(balanceOf(x.state(), A, B), 100n); assert.equal(x.state().tickets.get(K).status, 'settled');
  op(x, 0n, { kind: 'transfer', asset: A, to: F, amount: 30n }, B);
  assert.equal(balanceOf(x.state(), A, B), 70n); assert.equal(balanceOf(x.state(), A, F), 30n);
});
test('fee-bearing settlement checks both payment legs', () => {
  const x = fixture(); const t = x.state().tickets.get(K);
  assert.deepEqual(buyCall(t).calls.slice(1), [{ kind: 'pay', to: S, amount: offer.price }, { kind: 'pay', to: FEE, amount: saleFee(offer.price) }]);
  next(x, [purchase(x)]); assert.equal(balanceOf(x.state(), A, B), 100n); assert.equal(x.state().tickets.get(K).status, 'settled');
});
test('failed payment receipt has no approval effect and can be retried', () => {
  const x = fixture(); const r = purchase(x); r.success = false; r.events = [];
  next(x, [r]); assert.equal(x.state().tickets.get(K).status, 'locked'); assert.equal(balanceOf(x.state(), A, B), 0n);
  next(x, [purchase(x)]); assert.equal(x.state().tickets.get(K).status, 'settled');
});
test('native replay rejection cannot duplicate delivery', () => {
  const x = fixture(); const r = purchase(x); next(x, [r]); next(x, [{ ...r, hash: id(++serial), success: false, events: [] }]);
  assert.equal(balanceOf(x.state(), A, B), 100n); assert.throws(() => x.prepareBuy(K, B));
});
test('cancellation observed inside unsupported wrapper releases once', () => {
  const x = fixture(); const close = { kind: 'closed', multisig: M, proposal: 0 };
  next(x, [receipt(S, '0x1306', [close])]); next(x, [receipt(S, '0x1306', [close])]);
  assert.equal(balanceOf(x.state(), A, S), 500n); assert.throws(() => x.prepareBuy(K, B));
});
test('cleanup of a settled proposal never recredits the seller', () => {
  const x = fixture(); next(x, [purchase(x)]); next(x, [receipt(S, '0x1303', [{ kind: 'closed', multisig: M, proposal: 0 }])]);
  assert.equal(balanceOf(x.state(), A, S), 400n); assert.equal(balanceOf(x.state(), A, B), 100n);
});
test('standalone approval invalidates ticket without delivery', () => {
  const x = fixture(); next(x, [receipt(B, '0x1302', [{ kind: 'approved', multisig: M, proposal: 0, approver: B }])]);
  assert.equal(x.state().tickets.get(K).status, 'released'); assert.equal(balanceOf(x.state(), A, S), 500n);
});
test('inconsistent payment events cannot mint delivery', () => {
  const x = fixture(); const r = purchase(x); r.events.find(e => e.kind === 'paid').amount -= 1n;
  next(x, [r]); assert.equal(balanceOf(x.state(), A, B), 0n); assert.equal(x.state().tickets.get(K).status, 'released');
});
test('expiry is inclusive: unlock only at expiry+1', () => {
  const x = fixture({ ...offer, expiry: 7 }); next(x); next(x); assert.equal(x.state().tickets.get(K).status, 'locked');
  next(x); assert.equal(x.state().tickets.get(K).status, 'released'); assert.equal(balanceOf(x.state(), A, S), 500n);
});
test('tokens in reservation cannot be transferred or oversold', () => {
  const x = fixture(); op(x, 3n, { kind: 'transfer', asset: A, to: B, amount: 401n });
  assert.equal(balanceOf(x.state(), A, S), 400n); assert.equal(x.state().sequences.get(S), 3n);
  op(x, 3n, { kind: 'transfer', asset: A, to: B, amount: 400n }); assert.equal(balanceOf(x.state(), A, S), 0n);
});
test('invalid operations are audited and do not consume sequence', () => {
  const x = fixture(); op(x, 99n, { kind: 'mint', asset: A, amount: 1n }); op(x, 3n, { kind: 'mint', asset: A, amount: 1n }, S, id(999));
  op(x, 0n, { kind: 'mint', asset: A, amount: 1n }, B);
  assert.equal(x.state().assets.get(A).minted, 500n); assert.equal(x.state().sequences.get(S), 3n);
  assert.equal(x.state().journal.filter(j => j.verdict.startsWith('rejected')).length, 3);
});
test('cap and limit reject whole mint rather than partially issuing', () => {
  const x = fixture(); op(x, 3n, { kind: 'mint', asset: A, amount: 501n });
  op(x, 3n, { kind: 'mint', asset: A, amount: 500n }); op(x, 4n, { kind: 'mint', asset: A, amount: 1n });
  assert.equal(x.state().assets.get(A).minted, 1000n);
});
test('wrong call context does not create an offer from an ordinary remark', () => {
  const x = fixture(); next(x, [receipt(S, remark(envelope(3n, offer)), [{ kind: 'remarked', sender: S }])]);
  assert.match(x.state().journal.at(-1).verdict, /^rejected: offer requires direct proposal/); assert.equal(x.state().tickets.size, 1); assert.equal(balanceOf(x.state(), A, S), 400n);
});
test('prepareBuy rejects wrong buyer and unfinalized reservation', () => {
  const x = fixture(); assert.throws(() => x.prepareBuy(K, F));
  const y = fixture(offer, false); assert.throws(() => y.prepareBuy(K, B), /finalized/);
});
test('replay is deterministic, rollback removes provisional fill, finalized rollback refused', () => {
  const x = fixture(), y = fixture();
  const before = x.state(); const r = purchase(x); const block = next(x, [r]);
  x.rollback(before.height, before.hash); assert.equal(x.state().tickets.get(K).status, 'locked');
  x.apply(block); assert.equal(balanceOf(x.state(), A, B), 100n);
  assert.throws(() => x.rollback(3, G), /finalized/);
  const xState = x.state(); xState.balances.clear(); assert.equal(balanceOf(x.state(), A, B), 100n);
  const yr = { ...block, height: y.state().height + 1, parent: y.state().hash }; y.apply(yr);
  assert.deepEqual([...x.state().balances], [...y.state().balances]);
});
test('runtime drift, gaps and duplicate extrinsics halt without partial checkpoint', () => {
  const x = fixture(); const s = x.state(); const b = { height: s.height + 1, parent: s.hash, hash: id(++serial), spec: 153, txVersion: 6, finalized: 4, receipts: [] };
  assert.throws(() => x.apply(b), /runtime/); assert.deepEqual(x.state(), s);
  assert.throws(() => x.apply({ ...b, spec: 152, height: s.height + 2 }), /contiguous/);
  const r = purchase(x); assert.throws(() => x.apply({ ...b, spec: 152, receipts: [r, r] }), /duplicate/);
  assert.deepEqual(x.state(), s);
});
test('the reducer refuses mainnet without a pinned activation block', () => assert.throws(() => new NativeIndexer(MAINNET), /mainnet/));

// ---------------------------------------------------------------- QLYP-v1 fees
const feeEvents = (actor, amount) => [{ kind: 'remarked', sender: actor }, { kind: 'paid', from: actor, to: FEE, amount }, { kind: 'batchCompleted' }];
const batch = (...calls) => ({ kind: 'batch', calls });
const pay = (to, amount) => ({ kind: 'pay', to, amount });
const last = x => x.state().journal.at(-1).verdict;
test('saleFee is 1% rounded up', () => {
  for (const [p, f] of [[1n, 1n], [100n, 1n], [101n, 2n], [10000n, 100n], [10001n, 101n], [0n, 0n]]) assert.equal(saleFee(p), f);
  assert.throws(() => saleFee(-1n));
});
test('valid fee-batched deploy and mint are accepted; transfer stays free', () => {
  const x = new NativeIndexer(G); op(x, 0n, deploy); assert.equal(last(x), 'accepted');
  op(x, 1n, { kind: 'mint', asset: A, amount: 5n }); assert.equal(last(x), 'accepted');
  const t = { kind: 'transfer', asset: A, amount: 2n, to: B };
  assert.equal(parseCall(buildCall(G, S, 2n, t)).kind, 'remark');
  op(x, 2n, t); assert.equal(last(x), 'accepted'); assert.equal(balanceOf(x.state(), A, B), 2n);
  assert.equal(x.state().sequences.get(S), 3n);
});
test('bare remark deploy/mint (old v0 shape) is rejected without state effect', () => {
  const x = new NativeIndexer(G);
  next(x, [receipt(S, remark(envelope(0n, deploy)), [{ kind: 'remarked', sender: S }])]);
  assert.match(last(x), /^rejected: deploy\/mint requires the Qlyphs fee batch/); assert.equal(x.state().assets.size, 0); assert.equal(x.state().sequences.size, 0);
  op(x, 0n, deploy);
  next(x, [receipt(S, remark(envelope(1n, { kind: 'mint', asset: A, amount: 1n })), [{ kind: 'remarked', sender: S }])]);
  assert.match(last(x), /^rejected/); assert.equal(x.state().assets.get(A).minted, 0n); assert.equal(x.state().sequences.get(S), 1n);
});
for (const [name, calls, events] of [
  ['wrong amount', r => batch(r, pay(FEE, DEPLOY_FEE - 1n)), feeEvents(S, DEPLOY_FEE - 1n)],
  ['mint fee on a deploy', r => batch(r, pay(FEE, MINT_FEE)), feeEvents(S, MINT_FEE)],
  ['wrong recipient', r => batch(r, pay(F, DEPLOY_FEE)), [{ kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: F, amount: DEPLOY_FEE }, { kind: 'batchCompleted' }]],
  ['wrong order', r => batch(pay(FEE, DEPLOY_FEE), r), feeEvents(S, DEPLOY_FEE)],
  ['extra call', r => batch(r, pay(FEE, DEPLOY_FEE), pay(F, 1n)), [...feeEvents(S, DEPLOY_FEE), { kind: 'paid', from: S, to: F, amount: 1n }]],
  ['missing payment event', r => batch(r, pay(FEE, DEPLOY_FEE)), [{ kind: 'remarked', sender: S }, { kind: 'batchCompleted' }]],
  ['event amount mismatch', r => batch(r, pay(FEE, DEPLOY_FEE)), feeEvents(S, DEPLOY_FEE + 1n)],
  ['missing batchCompleted', r => batch(r, pay(FEE, DEPLOY_FEE)), feeEvents(S, DEPLOY_FEE).slice(0, 2)],
]) {
  test(`deploy fee batch rejected: ${name}`, () => {
    const x = new NativeIndexer(G);
    next(x, [receipt(S, calls(remark(envelope(0n, deploy))), events)]);
    assert.match(last(x), /^rejected/); assert.equal(x.state().assets.size, 0); assert.equal(x.state().sequences.size, 0);
  });
}
test('failed fee batch is rejected with no effect; retry succeeds', () => {
  const x = new NativeIndexer(G); const r = opReceipt(0n, deploy); r.success = false; r.events = [];
  next(x, [r]); assert.equal(x.state().assets.size, 0); assert.equal(x.state().sequences.size, 0);
  assert.equal(x.state().journal.length, 1); assert.equal(last(x), 'rejected: fee batch failed');
  op(x, 0n, deploy); assert.equal(last(x), 'accepted');
});
test('a transfer inside a fee batch is rejected (wrong context)', () => {
  const x = new NativeIndexer(G); op(x, 0n, deploy); op(x, 1n, { kind: 'mint', asset: A, amount: 5n });
  const t = { kind: 'transfer', asset: A, amount: 2n, to: B };
  next(x, [receipt(S, batch(remark(envelope(2n, t)), pay(FEE, MINT_FEE)), feeEvents(S, MINT_FEE))]);
  assert.match(last(x), /^rejected: transfer requires/); assert.equal(balanceOf(x.state(), A, B), 0n);
});
test('offers must commit exactly the 1% fee to Qlyphs', () => {
  for (const bad of [{ fee: 0n, feeTo: ZERO }, { fee: saleFee(offer.price) - 1n }, { fee: saleFee(offer.price) + 1n }, { feeTo: F }]) {
    const x = fixture({ ...offer, ...bad });
    assert.match(last(x), /^rejected: offer must commit/); assert.equal(x.state().tickets.size, 0); assert.equal(balanceOf(x.state(), A, S), 500n);
  }
  const x = fixture({ ...offer, price: 101n, fee: 2n }); assert.equal(x.state().tickets.get(K).offer.fee, 2n);
});
test('qlyphsFee, buildCall and preflight follow the v1 fee rules', () => {
  const x = fixture(); const s = x.state(); const t = s.tickets.get(K);
  assert.equal(qlyphsFee(deploy, undefined, LEGACY), DEPLOY_FEE); assert.equal(qlyphsFee({ kind: 'mint', asset: A, amount: 1n }), MINT_FEE);
  assert.equal(qlyphsFee({ kind: 'transfer', asset: A, amount: 1n, to: B }), 0n); assert.equal(qlyphsFee({ kind: 'sendQtc', to: B, amount: 1n }), 0n);
  assert.equal(qlyphsFee({ kind: 'buy', ticket: K }, t), saleFee(offer.price));
  assert.deepEqual(parseCall(buildCall(G, S, 0n, deploy, undefined, undefined, LEGACY)), batch(remark(envelope(0n, deploy)), pay(FEE, DEPLOY_FEE)));
  assert.deepEqual(parseCall(buildCall(G, S, 0n, { kind: 'sendQtc', to: B, amount: 7n })), pay(B, 7n));
  const sell = o => preflight(s, G, S, { kind: 'sell', multisig: M, offer: { ...o, expiry: s.height + 300 } }).call;
  assert.throws(() => sell({ ...offer, fee: 0n, feeTo: ZERO }), /sale fee/);
  assert.equal(parseCall(sell(withSaleFee({ ...offer, price: 12345n, fee: 0n, feeTo: ZERO }))).kind, 'propose');
});
