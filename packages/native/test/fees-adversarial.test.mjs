// Adversarial checks for the QLYP-v1 fee rules. Written against the spec, independently of the
// implementation: deploy/mint must travel in utility.batch_all([remark_with_event, transfer_keep_alive
// (QLYPHS_FEE_ACCOUNT, exact fee)]), transfers stay free bare remarks, offers commit a 1% sale fee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeIndexer, ZERO, assetId, assertInvariants, balanceOf, buildCall, buyCall, callBytes, decode, encode, hex,
  parseCall, preflight, qlyphsFee, saleFee, ticketKey,
  PROTOCOL_VERSION, PROTOCOL_LABEL, QLYPHS_FEE_ACCOUNT, LEGACY_DEPLOY_FEE as DEPLOY_FEE, MINT_FEE, SALE_FEE_BPS,
} from '../src/index.ts';

const FEE = QLYPHS_FEE_ACCOUNT;
// These tests read the legacy fees, which a development network without a fee schedule keeps.
const LEGACY = { legacy: true };
const id = n => '0x' + n.toString(16).padStart(64, '0');
const G = id(1000), S = id(1), B = id(2), M = id(3), F = id(4);
const A = assetId(S, 0n), K = ticketKey(M, 0);
const deploy = { kind: 'deploy', symbol: 'TEST', decimals: 6, cap: 1000n, limit: 500n, policy: 'issuer' };
const mint = (amount = 500n) => ({ kind: 'mint', asset: A, amount });
const PRICE = 10n ** 12n;
const offer = { kind: 'offer', asset: A, amount: 100n, buyer: B, payout: S, price: PRICE, fee: saleFee(PRICE), feeTo: FEE, expiry: 20 };
const envelope = (sequence, op, genesis = G) => ({ genesis, sequence, op });
const payloadOf = e => hex(encode(e));
const remarkCall = (payload, event = true) => ({ kind: 'remark', payload, event });
const payCall = (to, amount) => ({ kind: 'pay', to, amount });

let serial = 9000;
function receipt(signer, call, events = [], success = true, index = 0) {
  return { index, hash: id(++serial), signer, callHex: typeof call === 'string' ? call : hex(callBytes(call)), success, events };
}
function next(x, receipts = [], finalized = x.state().finalized) {
  const s = x.state();
  const b = { height: s.height + 1, hash: id(++serial), parent: s.hash, spec: 152, txVersion: 6, finalized, receipts };
  x.apply(b); return b;
}
const feeFor = p => (p.kind === 'deploy' ? DEPLOY_FEE : p.kind === 'mint' ? MINT_FEE : 0n);

/** Canonical v1 fee batch for deploy/mint, with every field overridable for attacks. */
function feeBatch(x, seq, p, o = {}) {
  const signer = o.signer ?? S;
  const fee = o.fee ?? feeFor(p);
  const payload = o.payload ?? payloadOf(envelope(seq, p));
  const remark = remarkCall(payload, o.remarkEvent ?? true);
  const pay = payCall(o.to ?? FEE, fee);
  const calls = o.calls ?? [remark, pay];
  const events = o.events ?? [
    { kind: 'remarked', sender: signer },
    { kind: 'paid', from: o.payer ?? signer, to: o.to ?? FEE, amount: o.paidAmount ?? fee },
    { kind: 'batchCompleted' },
  ];
  return next(x, [receipt(signer, o.call ?? { kind: 'batch', calls }, events, o.success ?? true)]);
}
/** Old v0-shaped bare remark_with_event. */
function bare(x, seq, p, actor = S) {
  return next(x, [receipt(actor, remarkCall(payloadOf(envelope(seq, p))), [{ kind: 'remarked', sender: actor }])]);
}
const last = x => x.state().journal.at(-1)?.verdict;
const seqOf = (x, a = S) => x.state().sequences.get(a) ?? 0n;

function base() {
  const x = new NativeIndexer(G);
  next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [S, B], threshold: 2 }])]);
  feeBatch(x, 0n, deploy); feeBatch(x, 1n, mint());
  return x;
}
function propose(x, p, seq = 2n) {
  const c = { kind: 'propose', multisig: M, call: remarkCall(payloadOf(envelope(seq, p)), false), expiry: p.expiry };
  return next(x, [receipt(S, c, [{ kind: 'created', multisig: M, proposal: 0, proposer: S }])]);
}
function fixture(p = offer) { const x = base(); propose(x, p); next(x, [], x.state().height); return x; }
function purchaseReceipt(t, legs, extraEvents) {
  const call = { kind: 'batch', calls: [{ kind: 'approve', multisig: t.multisig, proposal: t.proposal, call: parseCall(Uint8Array.from(Buffer.from(t.callHex.slice(2), 'hex'))) }, ...legs.map(l => payCall(l.to, l.amount))] };
  const events = [{ kind: 'approved', multisig: M, proposal: 0, approver: B }, ...legs.map(l => ({ kind: 'paid', from: B, to: l.to, amount: l.amount })), { kind: 'batchCompleted' }, ...(extraEvents ?? [])];
  return receipt(B, call, events);
}
/** Snapshot the parts of state a rejected op must never touch. */
const snap = x => { const s = x.state(); return { seq: [...s.sequences], assets: [...s.assets], balances: [...s.balances], tickets: [...s.tickets] }; };
function assertRejectedNoEffect(x, fn, re = /^rejected/) {
  const before = snap(x), jl = x.state().journal.length;
  fn();
  const s = x.state();
  assert.equal(s.journal.length, jl + 1, 'exactly one journal entry for the attempted op');
  assert.match(last(x), re);
  assert.deepEqual(snap(x), before, 'rejected op must have no state effect');
  assertInvariants(s);
}

// ---------------------------------------------------------------- constants and pure helpers
test('shared constants match the spec', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(PROTOCOL_LABEL, 'QLYP-v1');
  assert.equal(FEE, '0x2139a57532fbf4764ad95754c17545fed7af915fb008b6494b02e503084da8b3');
  assert.equal(DEPLOY_FEE, 1_000_000_000_000n);
  assert.equal(MINT_FEE, 10_000_000_000n);
  assert.equal(SALE_FEE_BPS, 100n);
});
test('saleFee is 1% rounded up, never zero for a positive price', () => {
  const cases = [[1n, 1n], [99n, 1n], [100n, 1n], [101n, 2n], [10000n, 100n], [10001n, 101n], [PRICE, 10n ** 10n], [PRICE + 1n, 10n ** 10n + 1n]];
  for (const [p, f] of cases) assert.equal(saleFee(p), f, `saleFee(${p})`);
  for (let p = 1n; p < 2000n; p += 7n) assert.equal(saleFee(p), (p * 100n + 9999n) / 10000n);
});
test('wire header is QLYP + 0x01 and v0 bytes no longer decode', () => {
  for (const p of [deploy, mint(1n), { kind: 'transfer', asset: A, amount: 2n, to: B }, offer]) {
    const b = encode(envelope(3n, p));
    assert.equal(hex(b).slice(0, 12), '0x514c595001');
    assert.deepEqual(decode(b), envelope(3n, p));
    const v0 = b.slice(); v0[4] = 0; assert.throws(() => decode(v0));
    const v2 = b.slice(); v2[4] = 2; assert.throws(() => decode(v2));
  }
});
test('qlyphsFee per command', () => {
  assert.equal(qlyphsFee(deploy, undefined, LEGACY), DEPLOY_FEE);
  assert.equal(qlyphsFee(mint(1n)), MINT_FEE);
  assert.equal(qlyphsFee({ kind: 'transfer', asset: A, amount: 1n, to: B }), 0n);
  assert.equal(qlyphsFee({ kind: 'sendQtc', to: B, amount: 5n }), 0n);
  assert.equal(qlyphsFee({ kind: 'pair', buyer: B, nonce: 0n }), 0n);
  assert.equal(qlyphsFee({ kind: 'sell', multisig: M, offer }), 0n);
  const x = fixture(); const t = x.state().tickets.get(K);
  assert.equal(qlyphsFee({ kind: 'buy', ticket: K }, t), saleFee(PRICE));
  assert.equal(qlyphsFee({ kind: 'cancel', ticket: K }, t), 0n);
});
test('buildCall: deploy/mint are exact fee batches, transfer bare remark, sendQtc plain pay', () => {
  const d = parseCall(buildCall(G, S, 0n, deploy, undefined, undefined, LEGACY));
  assert.deepEqual(d, { kind: 'batch', calls: [remarkCall(payloadOf(envelope(0n, deploy))), payCall(FEE, DEPLOY_FEE)] });
  const m = parseCall(buildCall(G, S, 1n, mint(7n)));
  assert.deepEqual(m, { kind: 'batch', calls: [remarkCall(payloadOf(envelope(1n, mint(7n)))), payCall(FEE, MINT_FEE)] });
  const tr = { kind: 'transfer', asset: A, amount: 3n, to: B };
  assert.deepEqual(parseCall(buildCall(G, S, 2n, tr)), remarkCall(payloadOf(envelope(2n, tr))));
  assert.deepEqual(parseCall(buildCall(G, S, 2n, { kind: 'sendQtc', to: B, amount: 5n })), payCall(B, 5n));
});
test('buildCall output is accepted by the indexer (round-trip through a real receipt)', () => {
  const x = new NativeIndexer(G);
  next(x, [receipt(S, hex(buildCall(G, S, 0n, deploy, undefined, undefined, LEGACY)), [{ kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: DEPLOY_FEE }, { kind: 'batchCompleted' }])]);
  assert.equal(last(x), 'accepted'); assert.ok(x.state().assets.has(A));
});

// ---------------------------------------------------------------- positive indexer paths
test('positive: fee-batched deploy and mint are accepted and advance sequence', () => {
  const x = base(); const s = x.state();
  assert.deepEqual(s.journal.map(j => j.verdict), ['accepted', 'accepted']);
  assert.equal(seqOf(x), 2n); assert.equal(balanceOf(s, A, S), 500n); assert.equal(s.assets.get(A).minted, 500n);
  assertInvariants(s);
});
test('positive: token transfer stays a free bare remark', () => {
  const x = base(); bare(x, 2n, { kind: 'transfer', asset: A, amount: 30n, to: F });
  assert.equal(last(x), 'accepted'); assert.equal(balanceOf(x.state(), A, F), 30n); assert.equal(seqOf(x), 3n);
});
test('positive: offer with exact 1% fee to Qlyphs locks, purchase pays both legs and settles', () => {
  const x = fixture(); const t = x.state().tickets.get(K);
  assert.equal(t.offer.fee, saleFee(PRICE)); assert.equal(t.offer.feeTo, FEE); assert.equal(seqOf(x), 3n);
  const call = buyCall(t);
  assert.deepEqual(call.calls.slice(1), [payCall(S, PRICE), payCall(FEE, saleFee(PRICE))]);
  assert.equal(hex(x.prepareBuy(K, B)), hex(callBytes(call)));
  next(x, [purchaseReceipt(t, [{ to: S, amount: PRICE }, { to: FEE, amount: saleFee(PRICE) }])]);
  assert.equal(x.state().tickets.get(K).status, 'settled'); assert.equal(balanceOf(x.state(), A, B), 100n);
  assertInvariants(x.state());
});
test('positive: open-policy mint by a non-creator pays its own fee', () => {
  const x = new NativeIndexer(G); feeBatch(x, 0n, { ...deploy, policy: 'open' });
  feeBatch(x, 0n, mint(10n), { signer: B }); assert.equal(last(x), 'accepted'); assert.equal(balanceOf(x.state(), A, B), 10n);
});

// ---------------------------------------------------------------- deploy/mint attacks
const attacks = [
  ['bare remark_with_event (v0 shape), no fee batch', (x, p, seq) => bare(x, seq, p)],
  ['fee paid to wrong account', (x, p, seq) => feeBatch(x, seq, p, { to: F })],
  // A former special-purpose address: the protocol gives it no role, so it is an ordinary account.
  ['fee paid to a former special-purpose address', (x, p, seq) => feeBatch(x, seq, p, { to: '0x4374767d38e54cf7c44368141b5aa50251e323168f76f797b006c89e70d61abd' })],
  ['fee paid to the zero account', (x, p, seq) => feeBatch(x, seq, p, { to: ZERO })],
  ['fee paid to self', (x, p, seq) => feeBatch(x, seq, p, { to: S })],
  ['fee 1 base unit short', (x, p, seq) => feeBatch(x, seq, p, { fee: feeFor(p) - 1n })],
  ['fee overpaid by 1 base unit', (x, p, seq) => feeBatch(x, seq, p, { fee: feeFor(p) + 1n })],
  ['zero-amount fee leg', (x, p, seq) => feeBatch(x, seq, p, { fee: 0n })],
  ['wrong fee tier (deploy<->mint swapped)', (x, p, seq) => feeBatch(x, seq, p, { fee: p.kind === 'deploy' ? MINT_FEE : DEPLOY_FEE })],
  ['calls in swapped order (pay, remark)', (x, p, seq) => {
    const r = remarkCall(payloadOf(envelope(seq, p))); return feeBatch(x, seq, p, { calls: [payCall(FEE, feeFor(p)), r] });
  }],
  ['3-call batch with an extra transfer', (x, p, seq) => {
    const r = remarkCall(payloadOf(envelope(seq, p)));
    return feeBatch(x, seq, p, { calls: [r, payCall(FEE, feeFor(p)), payCall(F, 1n)], events: [
      { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'paid', from: S, to: F, amount: 1n }, { kind: 'batchCompleted' }] });
  }],
  ['3-call batch with the fee split over two legs', (x, p, seq) => {
    const r = remarkCall(payloadOf(envelope(seq, p))), h = feeFor(p) / 2n;
    return feeBatch(x, seq, p, { calls: [r, payCall(FEE, h), payCall(FEE, feeFor(p) - h)], events: [
      { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: h }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) - h }, { kind: 'batchCompleted' }] });
  }],
  ['batch with only the remark (no pay leg)', (x, p, seq) => feeBatch(x, seq, p, {
    calls: [remarkCall(payloadOf(envelope(seq, p)))], events: [{ kind: 'remarked', sender: S }, { kind: 'batchCompleted' }] })],
  ['payment event from a different account than the signer', (x, p, seq) => feeBatch(x, seq, p, { payer: B })],
  ['payment event amount disagrees with call (short)', (x, p, seq) => feeBatch(x, seq, p, { paidAmount: feeFor(p) - 1n })],
  ['payment event to wrong account while call is correct', (x, p, seq) => feeBatch(x, seq, p, { events: [
    { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: F, amount: feeFor(p) }, { kind: 'batchCompleted' }] })],
  ['call pays short but events claim exact fee', (x, p, seq) => {
    const r = remarkCall(payloadOf(envelope(seq, p)));
    return feeBatch(x, seq, p, { calls: [r, payCall(FEE, feeFor(p) - 1n)], events: [
      { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'batchCompleted' }] });
  }],
  ['missing paid event', (x, p, seq) => feeBatch(x, seq, p, { events: [{ kind: 'remarked', sender: S }, { kind: 'batchCompleted' }] })],
  ['duplicate paid event', (x, p, seq) => feeBatch(x, seq, p, { events: [
    { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'batchCompleted' }] })],
  ['missing batchCompleted', (x, p, seq) => feeBatch(x, seq, p, { events: [
    { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }] })],
  ['two batchCompleted events', (x, p, seq) => feeBatch(x, seq, p, { events: [
    { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'batchCompleted' }, { kind: 'batchCompleted' }] })],
  ['two remarked events', (x, p, seq) => feeBatch(x, seq, p, { events: [
    { kind: 'remarked', sender: S }, { kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'batchCompleted' }] })],
  ['remarked by someone other than the signer', (x, p, seq) => feeBatch(x, seq, p, { events: [
    { kind: 'remarked', sender: B }, { kind: 'paid', from: S, to: FEE, amount: feeFor(p) }, { kind: 'batchCompleted' }] })],
  ['plain system.remark (no event) inside the fee batch', (x, p, seq) => feeBatch(x, seq, p, { remarkEvent: false })],
];
for (const [kind, p, seq, setup] of [['deploy', deploy, 0n, () => new NativeIndexer(G)], ['mint', mint(), 1n, () => { const x = new NativeIndexer(G); feeBatch(x, 0n, deploy); return x; }]]) {
  for (const [name, attack] of attacks) {
    test(`${kind} rejected: ${name}`, () => {
      const x = setup(); assertRejectedNoEffect(x, () => attack(x, p, seq));
      // the honest op at the same sequence still works afterwards
      feeBatch(x, seq, p); assert.equal(last(x), 'accepted'); assert.equal(seqOf(x), seq + 1n);
    });
  }
  test(`${kind}: extrinsic success=false (fee leg failed, batch reverted) is rejected with no effect`, () => {
    const x = setup(); const before = snap(x);
    feeBatch(x, seq, p, { success: false, events: [] });
    assert.deepEqual(snap(x), before); assert.equal(x.state().journal.length, Number(seq) + 1);
    assert.equal(last(x), 'rejected: fee batch failed');
    feeBatch(x, seq, p); assert.equal(last(x), 'accepted'); assert.equal(seqOf(x), seq + 1n);
  });
  test(`${kind}: success=false even with full events has no effect`, () => {
    const x = setup(); const before = snap(x);
    feeBatch(x, seq, p, { success: false });
    assert.equal(x.state().journal.length, Number(seq) + 1); assert.equal(last(x), 'rejected: fee batch failed');
    assert.deepEqual(snap(x), before);
  });
  test(`${kind}: failed bare remark (v0 shape) is rejected with no effect`, () => {
    const x = setup(); const before = snap(x);
    next(x, [receipt(S, remarkCall(payloadOf(envelope(seq, p))), [], false)]);
    assert.equal(last(x), 'rejected: extrinsic failed'); assert.deepEqual(snap(x), before);
  });
  test(`${kind}: remark and fee paid in two separate extrinsics is rejected`, () => {
    const x = setup(); const before = snap(x);
    const r1 = receipt(S, remarkCall(payloadOf(envelope(seq, p))), [{ kind: 'remarked', sender: S }], true, 0);
    const r2 = receipt(S, payCall(FEE, feeFor(p)), [{ kind: 'paid', from: S, to: FEE, amount: feeFor(p) }], true, 1);
    next(x, [r1, r2]); assert.deepEqual(snap(x), before); assert.match(last(x), /^rejected/);
  });
  test(`${kind}: v0 header inside a correct fee batch is not a QLYP operation`, () => {
    const x = setup(); const before = snap(x), jl = x.state().journal.length;
    const b = encode(envelope(seq, p)); b[4] = 0;
    feeBatch(x, seq, p, { payload: hex(b) });
    assert.deepEqual(snap(x), before);
    assert.ok(!x.state().journal.slice(jl).some(j => j.verdict === 'accepted'));
  });
  test(`${kind}: v0 bare remark is ignored like a foreign remark (no journal entry)`, () => {
    const x = setup(); const jl = x.state().journal.length, before = snap(x);
    const b = encode(envelope(seq, p)); b[4] = 0;
    next(x, [receipt(S, remarkCall(hex(b)), [{ kind: 'remarked', sender: S }])]);
    assert.deepEqual(snap(x), before); assert.equal(x.state().journal.length, jl);
  });
  test(`${kind}: fee batch wrapped in a multisig proposal is rejected`, () => {
    const x = setup(); next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [S, B], threshold: 2 }])]);
    const before = snap(x);
    const inner = { kind: 'batch', calls: [remarkCall(payloadOf(envelope(seq, p)), false), payCall(FEE, feeFor(p))] };
    let hexCall; try { hexCall = hex(callBytes({ kind: 'propose', multisig: M, call: inner, expiry: 50 })); } catch { return; }
    next(x, [receipt(S, hexCall, [{ kind: 'created', multisig: M, proposal: 0, proposer: S }])]);
    assert.deepEqual(snap(x), before);
  });
}
test('deploy: replaying an accepted fee batch (new hash) cannot deploy twice', () => {
  const x = new NativeIndexer(G); feeBatch(x, 0n, deploy); assert.equal(seqOf(x), 1n);
  assertRejectedNoEffect(x, () => feeBatch(x, 0n, deploy));
  assert.equal(x.state().assets.size, 1);
});
test('mint: valid fee does not bypass cap/limit; rejected mint keeps sequence', () => {
  const x = base();
  assertRejectedNoEffect(x, () => feeBatch(x, 2n, mint(501n)));
  assertRejectedNoEffect(x, () => feeBatch(x, 2n, mint(1n), { signer: B }), /^rejected/);
  feeBatch(x, 2n, mint(500n)); assert.equal(last(x), 'accepted'); assert.equal(x.state().assets.get(A).minted, 1000n);
  assertRejectedNoEffect(x, () => feeBatch(x, 3n, mint(1n)));
});
test('mint: wrong sequence inside a correct fee batch is rejected', () => {
  const x = base(); assertRejectedNoEffect(x, () => feeBatch(x, 9n, mint(1n)));
});
test('transfer: wrapping a (free) transfer in a fee batch is not a valid transfer', () => {
  const x = base(); const tr = { kind: 'transfer', asset: A, amount: 5n, to: F }; const before = snap(x);
  next(x, [receipt(S, { kind: 'batch', calls: [remarkCall(payloadOf(envelope(2n, tr))), payCall(FEE, MINT_FEE)] },
    [{ kind: 'remarked', sender: S }, { kind: 'paid', from: S, to: FEE, amount: MINT_FEE }, { kind: 'batchCompleted' }])]);
  assert.deepEqual(snap(x), before);
});

// ---------------------------------------------------------------- offer / sale attacks
const badOffers = [
  ['fee = saleFee - 1', { fee: saleFee(PRICE) - 1n }],
  ['fee = saleFee + 1 (overcommit)', { fee: saleFee(PRICE) + 1n }],
  ['fee 0 / feeTo zero', { fee: 0n, feeTo: ZERO }],
  ['feeTo = buyer', { feeTo: B }],
  ['feeTo = seller', { feeTo: S }],
  ['feeTo = unrelated account', { feeTo: F }],
  ['fee rounded down on a non-multiple price', { price: 10001n, fee: 100n }],
];
for (const [name, patch] of badOffers) {
  test(`offer rejected: ${name}`, () => {
    const x = base(); const p = { ...offer, ...patch };
    let ok = true; try { encode(envelope(2n, p)); } catch { ok = false; }
    if (!ok) return; // unencodable (e.g. feeTo=0 with fee>0) cannot even be signed
    assertRejectedNoEffect(x, () => propose(x, p));
    assert.equal(x.state().tickets.size, 0); assert.equal(balanceOf(x.state(), A, S), 500n); assert.equal(seqOf(x), 2n);
    propose(x, offer); assert.equal(last(x), 'accepted'); assert.equal(x.state().tickets.size, 1);
  });
  test(`preflight sell refuses: ${name}`, () => {
    const x = base(); for (let i = 0; i < 3; i++) next(x);
    const s = x.state(); const p = { ...offer, ...patch, expiry: s.height + 300 };
    assert.throws(() => preflight(s, G, S, { kind: 'sell', multisig: M, offer: p }));
  });
}
test('offer: small price has minimum 1 base unit fee and is accepted', () => {
  const x = base(); propose(x, { ...offer, price: 1n, fee: 1n }); assert.equal(last(x), 'accepted');
});
test('preflight sell accepts exact saleFee to Qlyphs and builds a proposal', () => {
  const x = base(); const s = x.state(); const p = { ...offer, expiry: s.height + 300 };
  const c = parseCall(preflight(s, G, S, { kind: 'sell', multisig: M, offer: p }).call);
  assert.equal(c.kind, 'propose'); assert.deepEqual(decode(Uint8Array.from(Buffer.from(c.call.payload.slice(2), 'hex'))).op, p);
});
test('purchase paying the 1% to the wrong account does not settle', () => {
  const x = fixture(); const t = x.state().tickets.get(K);
  next(x, [purchaseReceipt(t, [{ to: S, amount: PRICE }, { to: F, amount: saleFee(PRICE) }])]);
  assert.notEqual(x.state().tickets.get(K).status, 'settled'); assert.equal(balanceOf(x.state(), A, B), 0n);
  assertInvariants(x.state());
});
test('purchase omitting the fee leg does not settle', () => {
  const x = fixture(); const t = x.state().tickets.get(K);
  next(x, [purchaseReceipt(t, [{ to: S, amount: PRICE }])]);
  assert.notEqual(x.state().tickets.get(K).status, 'settled'); assert.equal(balanceOf(x.state(), A, B), 0n);
});
test('purchase with fee 1 base unit short does not settle', () => {
  const x = fixture(); const t = x.state().tickets.get(K);
  next(x, [purchaseReceipt(t, [{ to: S, amount: PRICE }, { to: FEE, amount: saleFee(PRICE) - 1n }])]);
  assert.notEqual(x.state().tickets.get(K).status, 'settled'); assert.equal(balanceOf(x.state(), A, B), 0n);
});
test('purchase with correct call but fee event redirected does not settle', () => {
  const x = fixture(); const t = x.state().tickets.get(K);
  const r = purchaseReceipt(t, [{ to: S, amount: PRICE }, { to: FEE, amount: saleFee(PRICE) }]);
  r.events.find(e => e.kind === 'paid' && e.to === FEE).to = F;
  next(x, [r]); assert.notEqual(x.state().tickets.get(K).status, 'settled'); assert.equal(balanceOf(x.state(), A, B), 0n);
});

// ---------------------------------------------------------------- global invariant under a storm of attacks
test('supply invariant and sequences intact after every attack in one chain', () => {
  const x = base(); const jl = x.state().journal.length;
  for (const [, attack] of attacks) attack(x, mint(1n), 2n);
  const s = x.state();
  assert.equal(seqOf(x), 2n); assert.equal(s.assets.get(A).minted, 500n); assert.equal(balanceOf(s, A, S), 500n);
  assert.ok(!s.journal.slice(jl).some(j => j.verdict === 'accepted'));
  assertInvariants(s);
  feeBatch(x, 2n, mint(1n)); assert.equal(last(x), 'accepted'); assert.equal(x.state().assets.get(A).minted, 501n);
});
test('failed transfer, offer or unrelated extrinsic gets no QLYP verdict', () => {
  const x = base(); const before = snap(x), jl = x.state().journal.length;
  const t = { kind: 'transfer', asset: A, amount: 1n, to: B };
  next(x, [receipt(S, remarkCall(payloadOf(envelope(2n, t))), [], false, 0),
    receipt(S, { kind: 'propose', multisig: M, call: remarkCall(payloadOf(envelope(2n, offer)), false), expiry: offer.expiry }, [], false, 1),
    receipt(S, payCall(B, 5n), [], false, 2),
    receipt(S, '0xdeadbeef', [], false, 3)]);
  assert.equal(x.state().journal.length, jl); assert.deepEqual(snap(x), before);
});
