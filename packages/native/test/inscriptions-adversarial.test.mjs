// Adversarial checks for QLYP-v1 unique symbols and Qlyph inscriptions (docs/native/INSCRIPTIONS.md),
// written from the spec and independently of the implementation: every payload (DEPLOY, INSCRIBE
// tag 9, TRANSFER, MINT, OFFER, and the RESERVED tags 4..8) is hand-encoded here, constants are own copies of the spec
// values, and every expectation is exact state (inscriptions, numbers, balances, assets, symbols,
// sequences, verdicts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../src/index.ts';

const { NativeIndexer, callBytes, decode, encode, hex, assertInvariants, parseCall, buyCall } = N;

// ---------------------------------------------------------------- spec constants (own copies)
const U = 10n ** 12n; // 1 QTC
const SPEC_INSCRIBE_FEE = 100_000_000_000n; // 0.1 QTC
const SPEC_DEPLOY_FEE = 1n * U;
const SPEC_MINT_FEE = 10_000_000_000n; // 0.01 QTC
const FEE = '0x2139a57532fbf4764ad95754c17545fed7af915fb008b6494b02e503084da8b3';
// A former special-purpose address. The protocol gives it no role, so it is an ordinary account:
// paying a fee to it is a wrong fee recipient, nothing more.
const FORMER_POOL = '0x4374767d38e54cf7c44368141b5aa50251e323168f76f797b006c89e70d61abd';
const ZERO = '0x' + '00'.repeat(32);
const HEADER_LEN = 5 + 32 + 8 + 1; // QLYP+ver, genesis, sequence, tag
const sf = p => (p * 100n + 9999n) / 10000n;

// ---------------------------------------------------------------- hand-written wire encoding
const le = (v, n) => { let s = ''; for (let i = 0; i < n; i++) s += ((BigInt(v) >> BigInt(8 * i)) & 255n).toString(16).padStart(2, '0'); return s; };
const cpt = v => { v = BigInt(v); if (v < 64n) return le(v << 2n, 1); if (v < 16384n) return le((v << 2n) | 1n, 2); if (v < 1n << 30n) return le((v << 2n) | 2n, 4); let n = 4; while (v >= 1n << BigInt(8 * n)) n++; return le(BigInt((n - 4) << 2) | 3n, 1) + le(v, n); };
const bytesHex = s => Buffer.from(s, 'latin1').toString('hex');
const vecHex = h => cpt(h.length / 2) + h;
const id = n => '0x' + n.toString(16).padStart(64, '0');
const G = id(9191);
const S = id(21), B = id(22), C = id(23), D = id(24), M = id(25), M2 = id(26);
const assetOf = (creator, seq) => creator + le(seq, 8);
function payload(seq, op, genesis = G) {
  let h = '0x514c595001' + genesis.slice(2) + le(seq, 8);
  switch (op.t) {
    case 'deploy': h += '00' + vecHex(bytesHex(op.symbol)) + le(op.decimals ?? 0, 1) + le(op.cap ?? 1000n, 16) + le(op.limit ?? 1000n, 16) + le(op.policy === 'open' ? 0 : 1, 1); break;
    case 'mint': h += '01' + op.asset.slice(2) + le(op.amount, 16); break;
    case 'transfer': h += '02' + op.asset.slice(2) + le(op.amount, 16) + op.to.slice(2); break;
    case 'offer': h += '03' + op.asset.slice(2) + le(op.amount, 16) + op.buyer.slice(2) + op.payout.slice(2) + le(op.price, 16) + le(op.fee, 16) + op.feeTo.slice(2) + le(op.expiry, 4); break;
    // RESERVED tags 4 to 6: plausible byte layouts, used only to prove that such payloads are
    // rejected as reserved operations with no effect.
    case 'launch': h += '04' + vecHex(bytesHex(op.symbol)); break;
    case 'buy': h += '05' + op.asset.slice(2) + le(op.qtcIn, 16) + le(op.minOut, 16); break;
    case 'sell': h += '06' + op.asset.slice(2) + le(op.tokensIn, 16) + le(op.minQtcOut, 16); break;
    // INSCRIBE: tag 9, contentType Vec<u8>, content Vec<u8>. `raw` overrides the body for malformed cases.
    case 'inscribe': h += '09' + (op.raw ?? (vecHex(op.ctHex ?? bytesHex(op.ct)) + vecHex(op.content))); break;
    default: throw new Error('bad op');
  }
  return h;
}

// ---------------------------------------------------------------- block/receipt plumbing
let serial = 90000;
const remark = (p, event = true) => ({ kind: 'remark', payload: p, event });
const pay = (to, amount) => ({ kind: 'pay', to, amount });
function receipt(signer, call, events, success = true, index = 0) {
  return { index, hash: id(++serial), signer, callHex: typeof call === 'string' ? call : hex(callBytes(call)), success, events };
}
function next(x, receipts = [], finalized) {
  const s = x.state();
  const b = { height: s.height + 1, hash: id(++serial), parent: s.hash, spec: 152, txVersion: 6, finalized: finalized ?? s.height, receipts };
  x.apply(b); return b;
}
const seqOf = (x, a) => x.state().sequences.get(a) ?? 0n;
const lastVerdict = x => x.state().journal.at(-1)?.verdict;
const journalLen = x => x.state().journal.length;
const bal = (x, a, o) => x.state().balances.get(`${a}:${o}`) ?? 0n;

/** A standard fee-batch receipt [remark_with_event(p), transfer_keep_alive(to, amount)], every part overridable. */
function feeReceipt(signer, p, to, amount, o = {}) {
  const calls = o.calls ?? [remark(p, o.remarkEvent ?? true), pay(to, amount)];
  const events = o.events ?? [
    { kind: 'remarked', sender: signer },
    { kind: 'paid', from: signer, to, amount: o.paidAmount ?? amount },
    { kind: 'batchCompleted' },
  ];
  return receipt(signer, o.callHex ?? { kind: 'batch', calls }, events, o.success ?? true, o.index ?? 0);
}
const inscribePayload = (seq, ct, content, o = {}) => payload(seq, { t: 'inscribe', ct, content, ctHex: o.ctHex, raw: o.raw }, o.genesis ?? G);
function inscribeReceipt(x, signer, ct, content, o = {}) {
  const seq = o.seq ?? seqOf(x, signer);
  const p = o.payload ?? inscribePayload(seq, ct, content, o);
  return feeReceipt(signer, p, o.to ?? FEE, o.fee ?? SPEC_INSCRIBE_FEE, o);
}
function inscribe(x, signer = S, ct = 'text/plain', content = '68656c6c6f', o = {}) {
  const seq = o.seq ?? seqOf(x, signer);
  next(x, [inscribeReceipt(x, signer, ct, content, { ...o, seq })]);
  return assetOf(signer, seq);
}
function deployReceipt(x, signer, symbol, o = {}) {
  const seq = o.seq ?? seqOf(x, signer);
  return feeReceipt(signer, payload(seq, { t: 'deploy', symbol, ...(o.def ?? {}) }), o.to ?? FEE, o.fee ?? SPEC_DEPLOY_FEE, o);
}
function launchReceipt(x, signer, symbol, o = {}) {
  const seq = o.seq ?? seqOf(x, signer);
  // A would-be LAUNCH (reserved tag 4) with a DEPLOY-sized fee batch: always rejected.
  return feeReceipt(signer, payload(seq, { t: 'launch', symbol }), o.to ?? FEE, o.fee ?? SPEC_DEPLOY_FEE, o);
}
const deploy = (x, signer, symbol, o = {}) => { const seq = o.seq ?? seqOf(x, signer); next(x, [deployReceipt(x, signer, symbol, { ...o, seq })]); return assetOf(signer, seq); };
const launch = (x, signer, symbol, o = {}) => { const seq = o.seq ?? seqOf(x, signer); next(x, [launchReceipt(x, signer, symbol, { ...o, seq })]); return assetOf(signer, seq); };
function transfer(x, signer, asset, amount, to, o = {}) {
  const seq = o.seq ?? seqOf(x, signer);
  next(x, [receipt(signer, remark(payload(seq, { t: 'transfer', asset, amount, to })), [{ kind: 'remarked', sender: signer }])]);
}
function mint(x, signer, asset, amount, o = {}) {
  const seq = o.seq ?? seqOf(x, signer);
  next(x, [feeReceipt(signer, payload(seq, { t: 'mint', asset, amount }), FEE, o.fee ?? SPEC_MINT_FEE, o)]);
}

// ---------------------------------------------------------------- state readers
const insMap = x => x.state().inscriptions;
const nextNo = x => BigInt(x.state().nextInscription);
const contentHexOf = i => (typeof i.content === 'string' ? i.content : hex(i.content));
const byNumber = (x, n) => [...insMap(x).values()].find(i => BigInt(i.number) === BigInt(n));
const numbers = x => [...insMap(x).values()].map(i => BigInt(i.number)).sort((a, b) => (a < b ? -1 : 1));

/** Everything a rejected op must never touch. */
const snap = x => {
  const s = x.state();
  return {
    seq: [...s.sequences], assets: [...s.assets], balances: [...s.balances], tickets: [...s.tickets],
    symbols: [...s.symbols], inscriptions: [...s.inscriptions], next: s.nextInscription,
  };
};
/** One journal entry, rejected, and no state effect at all. */
function assertRejectedNoEffect(x, fn, re = /^rejected/) {
  const before = snap(x), jl = journalLen(x);
  fn();
  assert.equal(journalLen(x), jl + 1, 'exactly one journal entry for the attempted op');
  assert.match(lastVerdict(x), re);
  assert.deepEqual(snap(x), before, 'rejected op must have no state effect');
  checkAll(x);
}
/** Not accepted and no state effect (the op may be rejected OR be outside the grammar and ignored). */
function assertNoEffect(x, fn) {
  const before = snap(x), jl = journalLen(x);
  fn();
  const added = x.state().journal.slice(jl);
  assert.ok(added.length <= 1, 'at most one journal entry');
  assert.ok(added.every(j => /^rejected/.test(j.verdict)), `not accepted: ${JSON.stringify(added)}`);
  assert.deepEqual(snap(x), before, 'no state effect');
  checkAll(x);
}
/** Spec invariants for symbols and inscriptions, plus the implementation's own invariant check. */
function checkAll(x) {
  const s = x.state();
  assertInvariants(s);
  for (const [sym, a] of s.symbols) {
    assert.match(sym, /^[A-Z0-9]{1,12}$/, 'symbols map key is a valid symbol');
    const asset = s.assets.get(a);
    assert.ok(asset, `symbol ${sym} points to an existing asset`);
    assert.equal(asset.definition.symbol, sym, 'symbol map agrees with the asset definition');
  }
  // every non-inscription asset has its symbol mapped to itself (first claim) — symbols are unique
  const seen = new Map();
  for (const [aid, a] of s.assets) {
    if (a.definition.policy === 'inscription') continue;
    assert.ok(!seen.has(a.definition.symbol), `duplicate symbol ${a.definition.symbol}`);
    seen.set(a.definition.symbol, aid);
    assert.equal(s.symbols.get(a.definition.symbol), aid);
  }
  assert.equal(s.symbols.size, seen.size, 'symbols map has exactly one entry per token asset');
  const nums = new Set();
  for (const [iid, i] of s.inscriptions) {
    assert.equal(i.id, iid);
    assert.equal(iid.length, 2 + 80, 'inscription id is 40 bytes');
    const n = BigInt(i.number);
    assert.ok(n >= 1n && n < BigInt(s.nextInscription), 'number in [1, next)');
    assert.ok(!nums.has(n), 'numbers unique'); nums.add(n);
    const a = s.assets.get(iid);
    assert.ok(a, 'inscription is also an asset');
    assert.equal(a.creator, i.creator);
    assert.equal(a.definition.symbol, '');
    assert.equal(Number(a.definition.decimals), 0);
    assert.equal(BigInt(a.definition.cap), 1n);
    assert.equal(BigInt(a.definition.limit), 0n);
    assert.equal(a.definition.policy, 'inscription');
    assert.equal(BigInt(a.minted), 1n, 'minted is exactly 1');
    let total = 0n;
    for (const [k, v] of s.balances) if (k.startsWith(iid + ':')) { assert.ok(v === 0n || v === 1n, 'balance 0 or 1'); total += v; }
    for (const t of s.tickets.values()) if (t.offer.asset === iid && t.status === 'locked') total += t.offer.amount;
    assert.equal(total, 1n, 'exactly one unit exists');
  }
  assert.equal(BigInt(nums.size), BigInt(s.nextInscription) - 1n, 'numbers are gap-free 1..next-1');
  for (const [aid, a] of s.assets) if (a.definition.policy === 'inscription') assert.ok(s.inscriptions.has(aid), 'inscription asset has a record');
}
const fresh = () => new NativeIndexer(G);

// ================================================================= constants and codec
// Without a fee schedule, a development network reads the legacy fees: these tests run there.
test('constants: legacy INSCRIBE fee is 0.1 QTC; legacy DEPLOY and MINT fees unchanged', () => {
  assert.equal(N.LEGACY_INSCRIBE_FEE, SPEC_INSCRIBE_FEE);
  assert.equal(N.LEGACY_DEPLOY_FEE, SPEC_DEPLOY_FEE);
  assert.equal(N.MINT_FEE, SPEC_MINT_FEE);
  assert.equal(N.MAX_PAYLOAD ?? 1024, 1024);
  assert.equal(N.legacyFee('inscribe'), SPEC_INSCRIBE_FEE);
  assert.equal(N.operationFee, undefined, 'operationFee is removed: fees depend on the schedule');
});
test('fresh state: empty symbols, empty inscriptions, nextInscription = 1', () => {
  const s = fresh().state();
  assert.ok(s.symbols instanceof Map); assert.equal(s.symbols.size, 0);
  assert.ok(s.inscriptions instanceof Map); assert.equal(s.inscriptions.size, 0);
  assert.equal(BigInt(s.nextInscription), 1n);
});
test('codec: hand-encoded tag 9 decodes to kind inscribe and re-encodes byte-identically', () => {
  const p = inscribePayload(7n, 'image/svg+xml', '3c7376672f3e');
  const e = decode(Buffer.from(p.slice(2), 'hex'));
  assert.equal(e.op.kind, 'inscribe');
  assert.equal(e.op.contentType, 'image/svg+xml');
  assert.equal(contentHexOf(e.op), '0x3c7376672f3e');
  assert.equal(e.sequence, 7n);
  assert.equal(hex(encode(e)), p);
});

// ================================================================= 1. unique symbols
test('symbol: second DEPLOY of a taken symbol in a later block is rejected with no effect, no sequence advance', () => {
  const x = fresh(); const a = deploy(x, S, 'AAA'); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(x.state().symbols.get('AAA'), a);
  assertRejectedNoEffect(x, () => deploy(x, B, 'AAA'), /^rejected: symbol taken$/);
  assert.equal(seqOf(x, B), 0n);
  // B's sequence 0 is still free for an honest op
  const b = deploy(x, B, 'BBB'); assert.equal(lastVerdict(x), 'accepted'); assert.equal(b, assetOf(B, 0n));
  checkAll(x);
});
test('symbol: same creator cannot re-deploy its own symbol', () => {
  const x = fresh(); deploy(x, S, 'AAA');
  assertRejectedNoEffect(x, () => deploy(x, S, 'AAA'), /^rejected: symbol taken$/);
  assert.equal(seqOf(x, S), 1n); assert.equal(x.state().assets.size, 1);
});
test('symbol: same block, first claim in extrinsic order wins (different creators)', () => {
  const x = fresh();
  next(x, [deployReceipt(x, B, 'RACE', { index: 0 }), deployReceipt(x, S, 'RACE', { index: 1 }), launchReceipt(x, C, 'RACE', { index: 2 })]);
  const j = x.state().journal;
  assert.deepEqual(j.map(e => e.verdict), ['accepted', 'rejected: symbol taken', 'rejected: reserved operation']);
  assert.deepEqual(j.map(e => e.index), [0, 1, 2]);
  assert.equal(x.state().symbols.get('RACE'), assetOf(B, 0n));
  assert.equal(seqOf(x, B), 1n); assert.equal(seqOf(x, S), 0n); assert.equal(seqOf(x, C), 0n);
  assert.equal(x.state().assets.size, 1);
  checkAll(x);
});
test('symbol: same block, same creator, later index is rejected', () => {
  const x = fresh();
  next(x, [deployReceipt(x, S, 'DUP', { seq: 0n, index: 0 }), deployReceipt(x, S, 'DUP', { seq: 1n, index: 1 })]);
  assert.deepEqual(x.state().journal.map(e => e.verdict), ['accepted', 'rejected: symbol taken']);
  assert.equal(seqOf(x, S), 1n); assert.equal(x.state().assets.size, 1);
});
test('symbol: same block, a would-be LAUNCH (reserved tag 4) first then DEPLOY → the deploy wins', () => {
  const x = fresh();
  next(x, [launchReceipt(x, C, 'PUMP', { index: 0 }), deployReceipt(x, S, 'PUMP', { index: 1 })]);
  assert.deepEqual(x.state().journal.map(e => e.verdict), ['rejected: reserved operation', 'accepted']);
  assert.equal(x.state().symbols.get('PUMP'), assetOf(S, 0n));
  assert.ok(!x.state().assets.has(assetOf(C, 0n))); assert.equal(seqOf(x, C), 0n);
  checkAll(x);
});
test('symbol: a would-be LAUNCH of a taken symbol is rejected as reserved, no effect', () => {
  const x = fresh(); const a = deploy(x, S, 'XYZ');
  assertRejectedNoEffect(x, () => launch(x, B, 'XYZ'), /^rejected: reserved operation$/);
  assert.equal(x.state().symbols.get('XYZ'), a);
});
test('symbol: a would-be LAUNCH never claims a symbol; a later DEPLOY takes it', () => {
  const x = fresh();
  assertRejectedNoEffect(x, () => launch(x, S, 'XYZ'), /^rejected: reserved operation$/);
  const a = deploy(x, B, 'XYZ'); assert.equal(lastVerdict(x), 'accepted');
  assertRejectedNoEffect(x, () => deploy(x, C, 'XYZ'), /^rejected: symbol taken$/);
  assert.equal(x.state().symbols.get('XYZ'), a);
});
test('symbol: a symbol differing only by a character is free; 12-char max is exact-match', () => {
  const x = fresh(); deploy(x, S, 'ABCDEFGHIJKL');
  deploy(x, B, 'ABCDEFGHIJK'); assert.equal(lastVerdict(x), 'accepted');
  deploy(x, C, 'ABCDEFGHIJKM'); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(x.state().symbols.size, 3); checkAll(x);
});
const nonReserving = [
  ['fee 1 unit short', o => ({ ...o, fee: SPEC_DEPLOY_FEE - 1n })],
  ['fee to an unrelated account', o => ({ ...o, to: D })],
  ['fee to the creator itself', o => ({ ...o, to: S })],
  ['bare remark (no fee batch)', o => ({ ...o, callHex: hex(callBytes(remark(o.p))), events: [{ kind: 'remarked', sender: o.signer }] })],
  ['wrong sequence', o => ({ ...o, seq: 5n })],
  ['extrinsic failed (success=false)', o => ({ ...o, success: false })],
];
for (const [name, patch] of nonReserving) {
  // Symbols are unique for DEPLOY only; a would-be LAUNCH (reserved tag 4) must not reserve either.
  for (const kind of ['deploy', 'launch']) {
    test(`symbol: a REJECTED first ${kind} (${name}) does not reserve the symbol`, () => {
      const x = fresh();
      const base = { signer: S, p: payload(0n, { t: kind, symbol: 'FREE' }) };
      const o = patch(base);
      const before = snap(x), jl = journalLen(x);
      if (o.seq !== undefined) { if (kind === 'deploy') deploy(x, S, 'FREE', { seq: o.seq }); else launch(x, S, 'FREE', { seq: o.seq }); }
      else next(x, [(kind === 'deploy' ? deployReceipt : launchReceipt)(x, S, 'FREE', o)]);
      // A failed extrinsic carrying a reserved tag is ordinary chain traffic (no verdict at all).
      const added = x.state().journal.slice(jl);
      if (kind === 'launch' && o.success === false) assert.equal(added.length, 0);
      else assert.match(lastVerdict(x) ?? '', /^rejected/);
      assert.ok(added.every(j => j.verdict !== 'accepted'));
      assert.deepEqual(snap(x), before);
      assert.ok(!x.state().symbols.has('FREE'));
      const b = deploy(x, B, 'FREE');
      assert.equal(lastVerdict(x), 'accepted');
      assert.equal(x.state().symbols.get('FREE'), b);
      checkAll(x);
    });
  }
}
test('symbol: rejected in-block first claim lets the second claim in the same block win', () => {
  const x = fresh();
  next(x, [deployReceipt(x, S, 'WIN', { index: 0, fee: SPEC_DEPLOY_FEE + 1n }), deployReceipt(x, B, 'WIN', { index: 1 })]);
  assert.match(x.state().journal[0].verdict, /^rejected/); assert.equal(x.state().journal[1].verdict, 'accepted');
  assert.equal(x.state().symbols.get('WIN'), assetOf(B, 0n)); checkAll(x);
});
test('symbol: inscriptions never enter the symbols map', () => {
  const x = fresh(); inscribe(x, S); inscribe(x, B); deploy(x, C, 'T');
  assert.deepEqual([...x.state().symbols.keys()], ['T']); assert.ok(!x.state().symbols.has(''));
  checkAll(x);
});
test('symbol: rollback of an unfinalized claim frees the symbol; the new branch claim wins', () => {
  const x = fresh(); next(x); next(x);
  const h = x.state().height, hash = x.state().hash;
  next(x, [deployReceipt(x, S, 'RE')], h);
  next(x, [inscribeReceipt(x, S, 'text/plain', '00')], h);
  assert.equal(x.state().symbols.get('RE'), assetOf(S, 0n)); assert.equal(nextNo(x), 2n);
  x.rollback(h, hash);
  assert.ok(!x.state().symbols.has('RE')); assert.equal(nextNo(x), 1n); assert.equal(insMap(x).size, 0);
  deploy(x, B, 'RE'); assert.equal(x.state().symbols.get('RE'), assetOf(B, 0n));
  const iid = inscribe(x, C); assert.equal(BigInt(insMap(x).get(iid).number), 1n); checkAll(x);
});

// ================================================================= 2. INSCRIBE — accepted path, exact state
test('inscribe: accepted — exact record, asset, balance, sequence, number', () => {
  const x = fresh(); deploy(x, S, 'TOK'); // sequence 0 → the inscription takes sequence 1
  const b = next(x, [receipt(C, '0xdeadbeef', [], true, 0), inscribeReceipt(x, S, 'text/plain', '68656c6c6f', { index: 1 })]);
  assert.equal(lastVerdict(x), 'accepted');
  const iid = assetOf(S, 1n), s = x.state();
  const i = s.inscriptions.get(iid);
  assert.ok(i);
  assert.equal(i.id, iid); assert.equal(BigInt(i.number), 1n); assert.equal(i.creator, S);
  assert.equal(i.contentType, 'text/plain'); assert.equal(contentHexOf(i), '0x68656c6c6f');
  assert.equal(i.height, b.height); assert.equal(i.index, 1);
  assert.equal(BigInt(s.nextInscription), 2n);
  assert.equal(bal(x, iid, S), 1n); assert.equal(s.assets.get(iid).minted, 1n);
  assert.equal(seqOf(x, S), 2n); assert.equal(s.symbols.size, 1);
  checkAll(x);
});
test('inscribe: first inscription of a fresh account uses sequence 0 and id = creator ‖ u64le(0)', () => {
  const x = fresh(); const iid = inscribe(x, B, 'a/b', 'ff');
  assert.equal(lastVerdict(x), 'accepted'); assert.equal(iid, B + '0000000000000000');
  assert.equal(seqOf(x, B), 1n); assert.equal(BigInt(byNumber(x, 1).number), 1n);
});

// ================================================================= 2a. inscription fee abuse
const F = SPEC_INSCRIBE_FEE;
const feeAttacks = [
  ['bare remark_with_event (no fee batch)', (x, s) => ({ callHex: hex(callBytes(remark(inscribePayload(seqOf(x, s), 'text/plain', '00')))), events: [{ kind: 'remarked', sender: s }] })],
  ['fee 1 base unit short', () => ({ fee: F - 1n })],
  ['fee overpaid by 1 base unit', () => ({ fee: F + 1n })],
  ['zero fee leg', () => ({ fee: 0n })],
  ['mint-tier fee (0.01 QTC)', () => ({ fee: SPEC_MINT_FEE })],
  ['deploy-tier fee (1 QTC)', () => ({ fee: SPEC_DEPLOY_FEE })],
  ['fee paid to a former special-purpose address', () => ({ to: FORMER_POOL })],
  ['fee paid to the creator (self)', (x, s) => ({ to: s })],
  ['fee paid to the zero account', () => ({ to: ZERO })],
  ['fee paid to an unrelated account', () => ({ to: D })],
  ['extra third call', (x, s) => {
    const p = inscribePayload(seqOf(x, s), 'text/plain', '00');
    return { calls: [remark(p), pay(FEE, F), pay(D, 1n)], events: [{ kind: 'remarked', sender: s }, { kind: 'paid', from: s, to: FEE, amount: F }, { kind: 'paid', from: s, to: D, amount: 1n }, { kind: 'batchCompleted' }] };
  }],
  ['fee split across two legs', (x, s) => {
    const p = inscribePayload(seqOf(x, s), 'text/plain', '00');
    return { calls: [remark(p), pay(FEE, F / 2n), pay(FEE, F / 2n)], events: [{ kind: 'remarked', sender: s }, { kind: 'paid', from: s, to: FEE, amount: F / 2n }, { kind: 'paid', from: s, to: FEE, amount: F / 2n }, { kind: 'batchCompleted' }] };
  }],
  ['calls in wrong order (pay, remark)', (x, s) => ({ calls: [pay(FEE, F), remark(inscribePayload(seqOf(x, s), 'text/plain', '00'))] })],
  ['batch with only the remark', (x, s) => ({ calls: [remark(inscribePayload(seqOf(x, s), 'text/plain', '00'))], events: [{ kind: 'remarked', sender: s }, { kind: 'batchCompleted' }] })],
  ['plain remark (no event) inside the batch', () => ({ remarkEvent: false })],
  ['missing paid event', (x, s) => ({ events: [{ kind: 'remarked', sender: s }, { kind: 'batchCompleted' }] })],
  ['missing remarked event', (x, s) => ({ events: [{ kind: 'paid', from: s, to: FEE, amount: F }, { kind: 'batchCompleted' }] })],
  ['missing batchCompleted', (x, s) => ({ events: [{ kind: 'remarked', sender: s }, { kind: 'paid', from: s, to: FEE, amount: F }] })],
  ['duplicate paid event', (x, s) => ({ events: [{ kind: 'remarked', sender: s }, { kind: 'paid', from: s, to: FEE, amount: F }, { kind: 'paid', from: s, to: FEE, amount: F }, { kind: 'batchCompleted' }] })],
  ['paid event amount short while call is exact', () => ({ paidAmount: F - 1n })],
  ['paid event from another account', (x, s) => ({ events: [{ kind: 'remarked', sender: s }, { kind: 'paid', from: D, to: FEE, amount: F }, { kind: 'batchCompleted' }] })],
  ['paid event to another account', (x, s) => ({ events: [{ kind: 'remarked', sender: s }, { kind: 'paid', from: s, to: D, amount: F }, { kind: 'batchCompleted' }] })],
  ['remarked by someone else', (x, s) => ({ events: [{ kind: 'remarked', sender: D }, { kind: 'paid', from: s, to: FEE, amount: F }, { kind: 'batchCompleted' }] })],
  ['wrong genesis', () => ({ genesis: id(1) })],
  ['wrong sequence (ahead)', (x, s) => ({ seq: seqOf(x, s) + 1n })],
];
for (const [name, mk] of feeAttacks) {
  test(`inscribe fee abuse rejected: ${name} — nothing inscribed, number not consumed`, () => {
    const x = fresh(); inscribe(x, S, 'text/plain', '01'); // #1 exists
    const o = mk(x, B);
    assertRejectedNoEffect(x, () => inscribe(x, B, 'text/plain', '00', o));
    assert.equal(nextNo(x), 2n); assert.equal(insMap(x).size, 1); assert.equal(seqOf(x, B), 0n);
    const iid = inscribe(x, B, 'text/plain', '00'); assert.equal(lastVerdict(x), 'accepted');
    assert.equal(BigInt(insMap(x).get(iid).number), 2n, 'next honest inscription gets number 2');
    checkAll(x);
  });
}
test('inscribe: failed extrinsic (batch reverted, success=false) → rejected: fee batch failed, no effect', () => {
  const x = fresh();
  assertRejectedNoEffect(x, () => inscribe(x, S, 'text/plain', '00', { success: false, events: [] }), /^rejected: fee batch failed$/);
  assertRejectedNoEffect(x, () => inscribe(x, S, 'text/plain', '00', { success: false }), /^rejected: fee batch failed$/);
  assert.equal(nextNo(x), 1n);
  inscribe(x, S); assert.equal(BigInt(byNumber(x, 1).number), 1n);
});
test('inscribe: remark and fee in two separate extrinsics is rejected', () => {
  const x = fresh(); const before = snap(x);
  const p = inscribePayload(0n, 'text/plain', '00');
  next(x, [receipt(S, remark(p), [{ kind: 'remarked', sender: S }], true, 0), receipt(S, pay(FEE, F), [{ kind: 'paid', from: S, to: FEE, amount: F }], true, 1)]);
  assert.match(lastVerdict(x), /^rejected/); assert.deepEqual(snap(x), before);
});
test('inscribe: replay of an accepted batch (new hash) cannot inscribe twice', () => {
  const x = fresh(); inscribe(x, S, 'text/plain', '00', { seq: 0n });
  assertRejectedNoEffect(x, () => inscribe(x, S, 'text/plain', '00', { seq: 0n }));
  assert.equal(nextNo(x), 2n);
});
test('inscribe: wrapped in a multisig proposal is not accepted', () => {
  const x = fresh(); next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [S, B], threshold: 2 }])]);
  const inner = remark(inscribePayload(0n, 'text/plain', '00'), false);
  assertNoEffect(x, () => next(x, [receipt(S, { kind: 'propose', multisig: M, call: inner, expiry: 50 }, [{ kind: 'created', multisig: M, proposal: 0, proposer: S }])]));
});
test('inscribe: a former special-purpose address is an ordinary account (no privileged signer)', () => {
  const x = fresh();
  const iid = inscribe(x, FORMER_POOL, 'text/plain', '00');
  assert.equal(lastVerdict(x), 'accepted'); assert.equal(BigInt(insMap(x).get(iid).number), 1n);
  assert.equal(seqOf(x, FORMER_POOL), 1n); checkAll(x);
});
test('inscribe: fee-batch rules hold for every creator — 20 attacks in one chain leave numbering intact', () => {
  const x = fresh(); const jl = journalLen(x);
  for (const [, mk] of feeAttacks) inscribe(x, C, 'text/plain', '00', mk(x, C));
  assert.ok(!x.state().journal.slice(jl).some(j => j.verdict === 'accepted'));
  assert.equal(nextNo(x), 1n); assert.equal(insMap(x).size, 0); assert.equal(seqOf(x, C), 0n);
  inscribe(x, C); assert.equal(BigInt(byNumber(x, 1).number), 1n); checkAll(x);
});

// ================================================================= 2b. numbering
test('numbering: strictly sequential from 1 across creators, blocks and in-block order; rejects never consume', () => {
  const x = fresh(); const expect = [];
  const ok = (signer, ct, c) => { const iid = inscribe(x, signer, ct, c); assert.equal(lastVerdict(x), 'accepted'); expect.push(iid); };
  ok(S, 'text/plain', '41');
  inscribe(x, B, 'text/plain', '42', { fee: F - 1n }); // rejected
  ok(B, 'text/plain', '42');
  inscribe(x, D, 'text/plain', '43', { to: FORMER_POOL }); // rejected (wrong fee recipient)
  inscribe(x, C, 'Text/plain', '43'); // rejected (content type)
  ok(C, 'image/png', '89504e47');
  // three in one block: S(ok), D(bad fee), B(ok) → numbers follow extrinsic order
  next(x, [inscribeReceipt(x, S, 'text/plain', '01', { index: 0 }), inscribeReceipt(x, D, 'text/plain', '02', { index: 1, to: FORMER_POOL }), inscribeReceipt(x, B, 'text/plain', '03', { index: 2 })]);
  expect.push(assetOf(S, 1n), assetOf(B, 1n));
  deploy(x, D, 'NOTNUM'); // a deploy does not consume a number
  ok(D, 'application/json', '7b7d');
  expect.forEach((iid, k) => assert.equal(BigInt(insMap(x).get(iid).number), BigInt(k + 1), `inscription ${k + 1}`));
  assert.deepEqual(numbers(x), expect.map((_, k) => BigInt(k + 1)));
  assert.equal(nextNo(x), BigInt(expect.length + 1));
  assert.equal(insMap(x).get(assetOf(S, 1n)).index, 0); assert.equal(insMap(x).get(assetOf(B, 1n)).index, 2);
  checkAll(x);
});
test('numbering: identical content (and type) by same and different creators gets distinct numbers and ids', () => {
  const x = fresh();
  const a = inscribe(x, S, 'text/plain', 'cafe'), b = inscribe(x, S, 'text/plain', 'cafe'), c = inscribe(x, B, 'text/plain', 'cafe');
  next(x, [inscribeReceipt(x, C, 'text/plain', 'cafe', { index: 0 }), inscribeReceipt(x, D, 'text/plain', 'cafe', { index: 1 })]);
  const all = [a, b, c, assetOf(C, 0n), assetOf(D, 0n)];
  assert.equal(new Set(all).size, 5);
  all.forEach((iid, k) => { const i = insMap(x).get(iid); assert.equal(BigInt(i.number), BigInt(k + 1)); assert.equal(contentHexOf(i), '0xcafe'); });
  assert.equal(nextNo(x), 6n); checkAll(x);
});
test('numbering: transferring or selling an inscription never renumbers it', () => {
  const x = fresh(); const a = inscribe(x, S); inscribe(x, B);
  transfer(x, S, a, 1n, C); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(BigInt(insMap(x).get(a).number), 1n); assert.equal(insMap(x).get(a).creator, S, 'creator is immutable');
  assert.equal(nextNo(x), 3n); checkAll(x);
});

// ================================================================= 2c. content / type
const badTypes = [
  ['uppercase type', 'Text/plain'],
  ['uppercase subtype', 'text/Plain'],
  ['space inside', 'text/ plain'],
  ['leading space', ' text/plain'],
  ['trailing space', 'text/plain '],
  ['trailing newline (regex $ must not match before \\n)', 'text/plain\n'],
  ['no slash', 'textplain'],
  ['two slashes', 'text/plain/x'],
  ['double slash', 'text//plain'],
  ['trailing slash', 'text/'],
  ['leading slash', '/plain'],
  ['2 bytes', 'a/'],
  ['1 byte', '/'],
  ['empty', ''],
  ['65 bytes', 'a/' + 'b'.repeat(63)],
  ['parameter with ;', 'text/html;x'],
  ['charset parameter', 'text/plain; charset=utf-8'],
  ['leading dot in type', '.a/b'],
  ['leading plus in subtype', 'a/+b'],
  ['leading dash in subtype', 'a/-b'],
  ['underscore', 'text/x_y'],
  ['star wildcard', '*/*'],
  ['NUL byte', 'text/plain\u0000'],
];
for (const [name, ct] of badTypes) {
  test(`content type rejected: ${name} (${JSON.stringify(ct)})`, () => {
    const x = fresh(); inscribe(x, S);
    assertRejectedNoEffect(x, () => inscribe(x, B, ct, '00'));
    assert.equal(nextNo(x), 2n); assert.equal(seqOf(x, B), 0n);
  });
}
test('content type rejected: non-ASCII (UTF-8 é) and invalid UTF-8 bytes', () => {
  const x = fresh();
  assertRejectedNoEffect(x, () => inscribe(x, S, null, '00', { ctHex: Buffer.from('text/plaé', 'utf8').toString('hex') }));
  assertRejectedNoEffect(x, () => inscribe(x, S, null, '00', { ctHex: bytesHex('text/') + 'ff' }));
  assertRejectedNoEffect(x, () => inscribe(x, S, null, '00', { ctHex: bytesHex('text/p') + 'c0' + 'af' }));
  assert.equal(nextNo(x), 1n);
});
const goodTypes = ['a/b', 'text/plain', 'image/svg+xml', 'application/vnd.api+json', 'model/gltf-binary', '0/9', 'a.b/c-d', 'a/' + 'b'.repeat(62), 'x' + 'y'.repeat(30) + '/' + 'z'.repeat(32)];
test('content type accepted at the boundaries (3 and 64 bytes) and with . + - digits', () => {
  const x = fresh();
  goodTypes.forEach((ct, k) => {
    const iid = inscribe(x, S, ct, '00');
    assert.equal(lastVerdict(x), 'accepted', ct);
    assert.equal(insMap(x).get(iid).contentType, ct); assert.equal(BigInt(insMap(x).get(iid).number), BigInt(k + 1));
  });
  assert.equal(goodTypes.at(-1).length, 64); assert.equal(goodTypes[0].length, 3);
  checkAll(x);
});
test('content: empty content rejected', () => {
  const x = fresh(); assertRejectedNoEffect(x, () => inscribe(x, S, 'text/plain', ''));
  assert.equal(nextNo(x), 1n);
});
test('content: 1 byte accepted; binary bytes preserved exactly', () => {
  const x = fresh(); const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('hex');
  const a = inscribe(x, S, 'application/octet-stream', '00'); const b = inscribe(x, S, 'application/octet-stream', all);
  assert.equal(contentHexOf(insMap(x).get(a)), '0x00'); assert.equal(contentHexOf(insMap(x).get(b)), '0x' + all);
});
const ct10 = 'text/plain';
const maxContent = 1024 - HEADER_LEN - 1 - ct10.length - 2; // 2-byte compact for the content length
test('content: payload of exactly 1024 bytes is accepted', () => {
  const x = fresh(); const content = 'ab'.repeat(maxContent);
  const p = inscribePayload(0n, ct10, content); assert.equal((p.length - 2) / 2, 1024);
  const iid = inscribe(x, S, ct10, content); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(contentHexOf(insMap(x).get(iid)).length, 2 + 2 * maxContent); checkAll(x);
});
test('content: payload of 1025 bytes is not inscribed and consumes nothing', () => {
  const x = fresh(); const content = 'ab'.repeat(maxContent + 1);
  assert.equal((inscribePayload(0n, ct10, content).length - 2) / 2, 1025);
  assertNoEffect(x, () => inscribe(x, S, ct10, content));
  assert.equal(nextNo(x), 1n); assert.equal(seqOf(x, S), 0n);
  inscribe(x, S); assert.equal(BigInt(byNumber(x, 1).number), 1n);
});
test('content: 64-byte content type with max remaining content still fits exactly 1024', () => {
  const x = fresh(); const ct = 'a/' + 'b'.repeat(62);
  const n = 1024 - HEADER_LEN - 2 - 64 - 2; // compact(64) is 2 bytes
  const content = 'cd'.repeat(n); assert.equal((inscribePayload(0n, ct, content).length - 2) / 2, 1024);
  inscribe(x, S, ct, content); assert.equal(lastVerdict(x), 'accepted');
  assertNoEffect(x, () => inscribe(x, S, ct, content + 'cd'));
});
const malformed = [
  ['non-canonical 2-byte length for contentType', () => le((10n << 2n) | 1n, 2) + bytesHex(ct10) + vecHex('00')],
  ['non-canonical 2-byte length for content', () => vecHex(bytesHex(ct10)) + le((1n << 2n) | 1n, 2) + '00'],
  ['non-canonical 4-byte length for content', () => vecHex(bytesHex(ct10)) + le((1n << 2n) | 2n, 4) + '00'],
  ['content length overstates remaining bytes', () => vecHex(bytesHex(ct10)) + cpt(5) + '0001'],
  ['contentType length overstates (eats content)', () => cpt(20) + bytesHex(ct10) + vecHex('00')],
  ['trailing byte after content', () => vecHex(bytesHex(ct10)) + vecHex('00') + '00'],
  ['missing content vector', () => vecHex(bytesHex(ct10))],
  ['empty body', () => ''],
  ['content length 0 then stray byte', () => vecHex(bytesHex(ct10)) + cpt(0) + '00'],
];
for (const [name, body] of malformed) {
  test(`inscribe malformed payload: ${name} — nothing inscribed`, () => {
    const x = fresh(); inscribe(x, S);
    assertRejectedNoEffect(x, () => inscribe(x, B, null, null, { raw: body() }));
    assert.equal(nextNo(x), 2n); assert.equal(seqOf(x, B), 0n);
  });
}
test('unknown tag 10 in a correct inscription fee batch is rejected, no effect', () => {
  const x = fresh(); const p = inscribePayload(0n, ct10, '00').replace(/^(0x.{90})09/, '$10a');
  assert.equal(p.slice(92, 94), '0a');
  assertRejectedNoEffect(x, () => inscribe(x, S, null, null, { payload: p }));
});

// ================================================================= 2d. ownership and trade
function withInscription() {
  const x = fresh();
  next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [S, B], threshold: 2 }]), receipt(C, '0x1300', [{ kind: 'multisig', id: M2, signers: [C, D], threshold: 2 }], true, 1)]);
  const a = inscribe(x, S, 'image/png', '89504e470d0a1a0a');
  assert.equal(lastVerdict(x), 'accepted');
  return { x, a };
}
for (const amount of [0n, 2n, 3n, (1n << 128n) - 1n]) {
  test(`transfer of an inscription with amount ${amount} is rejected, no effect`, () => {
    const { x, a } = withInscription();
    assertRejectedNoEffect(x, () => transfer(x, S, a, amount, B));
    assert.equal(bal(x, a, S), 1n); assert.equal(seqOf(x, S), 1n);
  });
}
test('transfer: non-owner (never held it) cannot move an inscription', () => {
  const { x, a } = withInscription();
  assertRejectedNoEffect(x, () => transfer(x, B, a, 1n, B));
  assertRejectedNoEffect(x, () => transfer(x, B, a, 1n, C));
  assert.equal(bal(x, a, S), 1n);
});
test('transfer: to the zero account is rejected', () => {
  const { x, a } = withInscription(); assertRejectedNoEffect(x, () => transfer(x, S, a, 1n, ZERO));
});
test('transfer amount 1 moves it (free, bare remark); afterwards only the new owner can transfer or offer', () => {
  const { x, a } = withInscription();
  transfer(x, S, a, 1n, C); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(bal(x, a, S), 0n); assert.equal(bal(x, a, C), 1n); assert.equal(seqOf(x, S), 2n);
  checkAll(x);
  // the creator can no longer move or sell it
  assertRejectedNoEffect(x, () => transfer(x, S, a, 1n, B));
  const h = x.state().height;
  assertRejectedNoEffect(x, () => propose(x, S, M, offerOp(a, 1n, B, S, h + 50)));
  // new owner can
  transfer(x, C, a, 1n, D); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(bal(x, a, D), 1n); assert.equal(bal(x, a, C), 0n);
  transfer(x, D, a, 1n, C); assert.equal(lastVerdict(x), 'accepted');
  const h2 = x.state().height;
  propose(x, C, M2, offerOp(a, 1n, D, C, h2 + 50)); assert.equal(lastVerdict(x), 'accepted');
  assert.equal(bal(x, a, C), 0n, 'offer locks the unit'); checkAll(x);
  // while locked the owner cannot transfer it
  assertRejectedNoEffect(x, () => transfer(x, C, a, 1n, B));
});
test('transfer: an inscription transfer wrapped in a fee batch is not a transfer', () => {
  const { x, a } = withInscription();
  assertNoEffect(x, () => next(x, [feeReceipt(S, payload(1n, { t: 'transfer', asset: a, amount: 1n, to: B }), FEE, F)]));
});

const PRICE = 5n * U;
function offerOp(asset, amount, buyer, seller, expiry, o = {}) {
  return { t: 'offer', asset, amount, buyer, payout: o.payout ?? seller, price: o.price ?? PRICE, fee: o.fee ?? sf(o.price ?? PRICE), feeTo: o.feeTo ?? FEE, expiry };
}
let proposal = 0;
function propose(x, seller, multisig, op, o = {}) {
  const seq = o.seq ?? seqOf(x, seller);
  const p = payload(seq, op);
  const n = o.proposal ?? proposal++;
  next(x, [receipt(seller, { kind: 'propose', multisig, call: remark(p, false), expiry: op.expiry }, [{ kind: 'created', multisig, proposal: n, proposer: seller }])]);
  return `${multisig}:${n}`;
}
function purchase(x, key, buyer, legsOverride) {
  const t = x.state().tickets.get(key);
  const legs = legsOverride ?? [{ to: t.offer.payout, amount: t.offer.price }, { to: t.offer.feeTo, amount: t.offer.fee }];
  const call = { kind: 'batch', calls: [{ kind: 'approve', multisig: t.multisig, proposal: t.proposal, call: parseCall(Uint8Array.from(Buffer.from(t.callHex.slice(2), 'hex'))) }, ...legs.map(l => pay(l.to, l.amount))] };
  const events = [{ kind: 'approved', multisig: t.multisig, proposal: t.proposal, approver: buyer }, ...legs.map(l => ({ kind: 'paid', from: buyer, to: l.to, amount: l.amount })), { kind: 'batchCompleted' }];
  next(x, [receipt(buyer, call, events)]);
}
for (const amount of [2n, 0n]) {
  test(`offer of an inscription with amount ${amount} is rejected, no ticket`, () => {
    const { x, a } = withInscription(); const h = x.state().height;
    assertRejectedNoEffect(x, () => propose(x, S, M, offerOp(a, amount, B, S, h + 50)));
    assert.equal(x.state().tickets.size, 0); assert.equal(bal(x, a, S), 1n);
  });
}
test('offer: non-owner cannot offer an inscription', () => {
  const { x, a } = withInscription(); const h = x.state().height;
  assertRejectedNoEffect(x, () => propose(x, C, M2, offerOp(a, 1n, D, C, h + 50)));
});
test('offer amount 1 sells it: exact 1% sale fee, ownership moves to buyer, supply stays 1', () => {
  const { x, a } = withInscription(); const h = x.state().height;
  const key = propose(x, S, M, offerOp(a, 1n, B, S, h + 50));
  assert.equal(lastVerdict(x), 'accepted');
  const t = x.state().tickets.get(key);
  assert.equal(t.status, 'locked'); assert.equal(t.offer.amount, 1n); assert.equal(t.offer.fee, PRICE / 100n); assert.equal(t.offer.feeTo, FEE);
  assert.equal(bal(x, a, S), 0n); checkAll(x);
  next(x, [], x.state().height);
  if (typeof buyCall === 'function') {
    const bc = buyCall(t); assert.deepEqual(bc.calls.slice(1), [pay(S, PRICE), pay(FEE, PRICE / 100n)]);
  }
  purchase(x, key, B);
  assert.equal(x.state().tickets.get(key).status, 'settled');
  assert.equal(bal(x, a, B), 1n); assert.equal(bal(x, a, S), 0n);
  assert.equal(BigInt(insMap(x).get(a).number), 1n); assert.equal(insMap(x).get(a).creator, S);
  checkAll(x);
  // the buyer now owns it: can transfer; seller cannot
  assertRejectedNoEffect(x, () => transfer(x, S, a, 1n, C));
  transfer(x, B, a, 1n, C); assert.equal(lastVerdict(x), 'accepted'); assert.equal(bal(x, a, C), 1n);
  checkAll(x);
});
test('offer of an inscription with the fee 1 unit short is rejected', () => {
  const { x, a } = withInscription(); const h = x.state().height;
  assertRejectedNoEffect(x, () => propose(x, S, M, offerOp(a, 1n, B, S, h + 50, { fee: sf(PRICE) - 1n })));
});
test('purchase of an inscription omitting the 1% leg does not settle; unit stays locked/returns, supply 1', () => {
  const { x, a } = withInscription(); const h = x.state().height;
  const key = propose(x, S, M, offerOp(a, 1n, B, S, h + 50));
  next(x, [], x.state().height);
  purchase(x, key, B, [{ to: S, amount: PRICE }]);
  assert.notEqual(x.state().tickets.get(key).status, 'settled'); assert.equal(bal(x, a, B), 0n);
  checkAll(x);
});
test('double-sell: after an accepted offer locks the unit, a second offer of the same inscription is rejected', () => {
  const { x, a } = withInscription(); const h = x.state().height;
  propose(x, S, M, offerOp(a, 1n, B, S, h + 50)); assert.equal(lastVerdict(x), 'accepted');
  assertRejectedNoEffect(x, () => propose(x, S, M, offerOp(a, 1n, B, S, h + 60)));
  assertRejectedNoEffect(x, () => transfer(x, S, a, 1n, C));
});
test('mint on an inscription asset is rejected (creator, exact mint fee), no effect', () => {
  const { x, a } = withInscription();
  assertRejectedNoEffect(x, () => mint(x, S, a, 1n));
  assertRejectedNoEffect(x, () => mint(x, B, a, 1n));
  assertRejectedNoEffect(x, () => mint(x, S, a, 1n, { fee: F }));
  assert.equal(x.state().assets.get(a).minted, 1n);
});
test('mint on an inscription after it was transferred away (creator balance 0) is still rejected', () => {
  const { x, a } = withInscription(); transfer(x, S, a, 1n, B);
  assertRejectedNoEffect(x, () => mint(x, S, a, 1n));
  assertRejectedNoEffect(x, () => mint(x, B, a, 1n));
});
test('reserved tags 5 and 6 naming an inscription: rejected, no effect, no refund', () => {
  const { x, a } = withInscription();
  const p = payload(1n, { t: 'buy', asset: a, qtcIn: U, minOut: 0n });
  // A tag-5 batch paying that former address is simply rejected: no payout, no refund state.
  assertRejectedNoEffect(x, () => next(x, [feeReceipt(S, p, FORMER_POOL, U + sf(U))]), /^rejected: reserved operation$/);
  const q = payload(1n, { t: 'sell', asset: a, tokensIn: 1n, minQtcOut: 0n });
  assertRejectedNoEffect(x, () => next(x, [receipt(S, remark(q), [{ kind: 'remarked', sender: S }])]), /^rejected: reserved operation$/);
  assert.equal(bal(x, a, S), 1n);
});
test('supply invariant holds across a long mixed attack chain', () => {
  const { x, a } = withInscription(); const h = x.state().height;
  transfer(x, S, a, 2n, B); transfer(x, B, a, 1n, B); mint(x, S, a, 1n); transfer(x, S, a, 0n, B);
  propose(x, S, M, offerOp(a, 2n, B, S, h + 50));
  transfer(x, S, a, 1n, B); transfer(x, B, a, 1n, D); transfer(x, S, a, 1n, C);
  inscribe(x, D, 'text/plain', '00', { to: FORMER_POOL }); inscribe(x, D, 'TEXT/PLAIN', '00');
  assert.equal(bal(x, a, D), 1n); assert.equal(bal(x, a, S), 0n); assert.equal(bal(x, a, B), 0n); assert.equal(bal(x, a, C), 0n);
  assert.equal(nextNo(x), 2n); checkAll(x);
});
