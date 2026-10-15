// Unique symbols and Qlyph inscriptions (docs/native/INSCRIPTIONS.md), driven through the same
// builders the wallet uses (buildCall / preflight).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeIndexer, assetId, assertInvariants, balanceOf, buyCall, callBytes, decode, encode, fromHex, hex,
  parseCall, ticketKey, buildCall, parseCommand, preflight, qlyphsFee, legacyFee, saleFee,
  QLYPHS_FEE_ACCOUNT as FEE, LEGACY_INSCRIBE_FEE as INSCRIBE_FEE, LEGACY_DEPLOY_FEE as DEPLOY_FEE, MINT_FEE,
  MAX_PAYLOAD, RULES_MARKER, FIRST_INSCRIPTION, INSCRIPTION_DEFINITION, isContentType,
} from '../src/index.ts';

const id = n => '0x' + n.toString(16).padStart(64, '0');
const G = id(4242), S = id(1), B = id(2), C = id(3), M = id(7), X = id(9);
let serial = 70000;
const receipt = (signer, callHex, events = [], success = true, index = 0) =>
  ({ index, hash: id(++serial), signer, callHex, success, events });
function next(x, receipts = [], finalized) {
  const s = x.state();
  const b = { height: s.height + 1, hash: id(++serial), parent: s.hash, spec: 152, txVersion: 6, finalized: finalized ?? s.height + 1, receipts };
  x.apply(b); return b;
}
const seq = (x, a) => x.state().sequences.get(a) ?? 0n;
const last = x => x.state().journal.at(-1).verdict;
const feeEvents = (from, amount, to = FEE) => [{ kind: 'remarked', sender: from }, { kind: 'paid', from, to, amount }, { kind: 'batchCompleted' }];
const remarkEvents = from => [{ kind: 'remarked', sender: from }];
const PNG = '0x89504e470d0a1a0a';
// A development network without a fee schedule reads the legacy fees.
const LEGACY = { legacy: true };
/** A wallet-built receipt for a command (fee batch events for fee-bearing operations). */
function cmdReceipt(x, actor, c, index = 0) {
  const fee = qlyphsFee(c, undefined, LEGACY);
  const callHex = hex(buildCall(G, actor, seq(x, actor), c, undefined, undefined, LEGACY));
  return receipt(actor, callHex, fee > 0n ? feeEvents(actor, fee) : remarkEvents(actor), true, index);
}
function cmd(x, actor, c) { next(x, [cmdReceipt(x, actor, c)]); return last(x); }
const inscribe = (x, actor = S, contentType = 'image/png', content = PNG) => {
  const a = assetId(actor, seq(x, actor));
  assert.equal(cmd(x, actor, { kind: 'inscribe', contentType, content }), 'accepted');
  return a;
};
/** Everything a rejected operation must leave untouched. */
const snap = x => {
  const s = x.state();
  return { seq: [...s.sequences], assets: [...s.assets], balances: [...s.balances], tickets: [...s.tickets], symbols: [...s.symbols], inscriptions: [...s.inscriptions], next: s.nextInscription };
};
function rejected(x, r, pattern) {
  const before = snap(x);
  next(x, [r]);
  assert.match(last(x), pattern);
  assert.deepEqual(snap(x), before, 'a rejected operation has no state effect');
}
const raw = (sequence, tagAndBody) =>
  '0x514c595001' + G.slice(2) + Buffer.from(new BigUint64Array([sequence]).buffer).toString('hex') + tagAndBody;
const vec = s => { const b = Buffer.from(s); return (b.length << 2).toString(16).padStart(2, '0') + b.toString('hex'); };
/** A would-be LAUNCH (RESERVED tag 4) in an exact DEPLOY-sized fee batch. */
function launchReceipt(x, actor, symbol, index = 0) {
  const payload = raw(seq(x, actor), '04' + vec(symbol));
  const callHex = hex(callBytes({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount: DEPLOY_FEE }] }));
  return receipt(actor, callHex, feeEvents(actor, DEPLOY_FEE), true, index);
}

test('constants, fee and content type rule', () => {
  assert.equal(INSCRIBE_FEE, 100_000_000_000n);
  assert.equal(legacyFee('inscribe'), INSCRIBE_FEE);
  assert.equal(qlyphsFee({ kind: 'inscribe', contentType: 'text/plain', content: '0x00' }, undefined, LEGACY), INSCRIBE_FEE);
  assert.equal(FIRST_INSCRIPTION, 1);
  assert.deepEqual(INSCRIPTION_DEFINITION, { kind: 'deploy', symbol: '', decimals: 0, cap: 1n, limit: 0n, policy: 'inscription' });
  for (const ok of ['a/b', 'image/png', 'image/svg+xml', 'text/plain', 'application/json', 'application/vnd.a-b.c+json', '0/0', 'a'.repeat(30) + '/' + 'b'.repeat(33)])
    assert.equal(isContentType(ok), true, ok);
  for (const bad of ['', 'a/', '/b', 'ab', 'Image/png', 'text/Plain', 'text /plain', 'text/plain; charset=utf-8', '-a/b', 'a/.b', 'a/b/c', 'a'.repeat(31) + '/' + 'b'.repeat(33), 'tëxt/plain', 'text\\plain', 'text/plain\n', 7, null])
    assert.equal(isContentType(bad), false, String(bad));
  assert.ok(RULES_MARKER.includes('inscriptions'), 'stores re-index under the new rules');
});

test('codec: INSCRIBE is tag 9 = Vec<u8> contentType, Vec<u8> content; malformed payloads are refused', () => {
  const op = { kind: 'inscribe', contentType: 'text/plain', content: '0x6869' };
  const e = { genesis: G, sequence: 5n, op };
  const b = encode(e);
  assert.equal(hex(b), raw(5n, '09' + vec('text/plain') + '08' + '6869'));
  assert.deepEqual(decode(b), e);
  for (let n = 0; n < b.length; n++) assert.throws(() => decode(b.slice(0, n)));
  // Content type rule on both sides.
  for (const ct of ['Text/plain', 'text', 'ab', 'a/b/c', 'x'.repeat(33) + '/' + 'y'.repeat(31)]) {
    assert.throws(() => encode({ genesis: G, sequence: 0n, op: { ...op, contentType: ct } }), /content type/);
    assert.throws(() => decode(fromHex(raw(0n, '09' + vec(ct) + '04' + 'ff'))));
  }
  // 65-byte content type: vector too large.
  assert.throws(() => decode(fromHex(raw(0n, '09' + '0501' + Buffer.from('a/' + 'b'.repeat(63)).toString('hex') + '04ff'))));
  // Empty content, non-canonical hex.
  assert.throws(() => encode({ genesis: G, sequence: 0n, op: { ...op, content: '0x' } }), /empty/);
  assert.throws(() => decode(fromHex(raw(0n, '09' + vec('text/plain') + '00'))), /empty/);
  assert.throws(() => encode({ genesis: G, sequence: 0n, op: { ...op, content: '0xAB' } }), /hex/);
  // The largest content that fits one payload, and one byte more.
  const overhead = 5 + 32 + 8 + 1 + 1 + 'text/plain'.length + 2;
  const max = MAX_PAYLOAD - overhead;
  const fits = encode({ genesis: G, sequence: 0n, op: { ...op, content: '0x' + 'ab'.repeat(max) } });
  assert.equal(fits.length, MAX_PAYLOAD);
  assert.equal(decode(fits).op.content.length, 2 + 2 * max);
  assert.throws(() => encode({ genesis: G, sequence: 0n, op: { ...op, content: '0x' + 'ab'.repeat(max + 1) } }), /payload too large/);
});

test('inscribe: accepted — asset (cap 1, decimals 0, no symbol), balance 1, record, number 1', () => {
  const x = new NativeIndexer(G);
  next(x);
  const r = cmdReceipt(x, S, { kind: 'inscribe', contentType: 'image/png', content: PNG }, 3);
  // The exact v1 fee batch: remark_with_event + transfer_keep_alive(FEE, 0.1 QTC).
  const call = parseCall(fromHex(r.callHex));
  assert.equal(call.kind, 'batch'); assert.equal(call.calls.length, 2);
  assert.deepEqual(call.calls[1], { kind: 'pay', to: FEE, amount: INSCRIBE_FEE });
  next(x, [r]);
  assert.equal(last(x), 'accepted');
  const s = x.state(), a = assetId(S, 0n);
  assert.deepEqual(s.assets.get(a), { creator: S, definition: INSCRIPTION_DEFINITION, minted: 1n });
  assert.equal(balanceOf(s, a, S), 1n);
  assert.deepEqual(s.inscriptions.get(a), { id: a, number: 1, creator: S, contentType: 'image/png', content: PNG, height: 2, index: 3 });
  assert.equal(s.nextInscription, 2);
  assert.equal(seq(x, S), 1n);
  assert.equal(s.symbols.size, 0, 'inscriptions have no symbol');
  assertInvariants(s);
});

test('inscribe: sequential numbering, identical content allowed, rejections never consume a number', () => {
  const x = new NativeIndexer(G);
  const a = inscribe(x, S, 'text/plain', '0x6869');
  const b = inscribe(x, B, 'text/plain', '0x6869'); // same content, other creator
  const c = inscribe(x, S, 'text/plain', '0x6869'); // same content, same creator
  // A rejected inscribe (fee short) in between.
  const r = cmdReceipt(x, C, { kind: 'inscribe', contentType: 'text/plain', content: '0x6869' });
  r.events = feeEvents(C, INSCRIBE_FEE - 1n);
  rejected(x, r, /^rejected: fee batch receipt/);
  const d = inscribe(x, C, 'application/json', '0x7b7d');
  const s = x.state();
  assert.deepEqual([a, b, c, d].map(k => s.inscriptions.get(k).number), [1, 2, 3, 4]);
  assert.equal(s.nextInscription, 5);
  assert.equal(new Set([a, b, c, d]).size, 4);
  // Two inscriptions in one block are numbered in extrinsic order.
  const r1 = cmdReceipt(x, S, { kind: 'inscribe', contentType: 'a/b', content: '0x01' }, 0);
  const r2 = cmdReceipt(x, B, { kind: 'inscribe', contentType: 'a/b', content: '0x02' }, 1);
  next(x, [r1, r2]);
  assert.equal(x.state().inscriptions.get(assetId(S, 2n)).number, 5);
  assert.equal(x.state().inscriptions.get(assetId(B, 1n)).number, 6);
  assertInvariants(x.state());
});

test('inscribe rejected: fee missing, short, over, wrong recipient, failed batch', () => {
  const x = new NativeIndexer(G);
  next(x);
  const op = { kind: 'inscribe', contentType: 'image/png', content: PNG };
  const payload = hex(encode({ genesis: G, sequence: 0n, op }));
  // Bare remark_with_event (no fee batch).
  rejected(x, receipt(S, hex(callBytes({ kind: 'remark', event: true, payload })), remarkEvents(S)), /inscribe requires the Qlyphs fee batch/);
  // Short / over / deploy-tier fee.
  for (const amount of [INSCRIBE_FEE - 1n, INSCRIBE_FEE + 1n, DEPLOY_FEE, MINT_FEE]) {
    const callHex = hex(callBytes({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount }] }));
    rejected(x, receipt(S, callHex, feeEvents(S, amount)), /fee batch must be exactly/);
  }
  // Exact call bytes but the receipt shows a short payment.
  const good = hex(buildCall(G, S, 0n, op, undefined, undefined, LEGACY));
  rejected(x, receipt(S, good, feeEvents(S, INSCRIBE_FEE - 1n)), /fee batch receipt/);
  // Wrong recipient (call and events).
  const wrong = hex(callBytes({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: X, amount: INSCRIBE_FEE }] }));
  rejected(x, receipt(S, wrong, feeEvents(S, INSCRIBE_FEE, X)), /fee batch must be exactly/);
  rejected(x, receipt(S, good, feeEvents(S, INSCRIBE_FEE, X)), /fee batch receipt/);
  // Failed extrinsic (the fee leg reverted the batch).
  const before = snap(x);
  next(x, [receipt(S, good, [], false)]);
  assert.equal(last(x), 'rejected: fee batch failed');
  assert.deepEqual(snap(x), before);
  // Retry with the exact batch succeeds at number 1.
  assert.equal(inscribe(x), assetId(S, 0n));
  assert.equal(x.state().inscriptions.get(assetId(S, 0n)).number, 1);
});

test('inscription assets: MINT rejected, TRANSFER/OFFER amount must be 1', () => {
  const x = new NativeIndexer(G);
  next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [S, B], threshold: 2 }])]);
  const a = inscribe(x);
  // MINT through the exact fee batch is rejected.
  rejected(x, cmdReceipt(x, S, { kind: 'mint', asset: a, amount: 1n }), /inscriptions cannot be minted/);
  // TRANSFER of 2 is rejected (0 does not encode).
  rejected(x, cmdReceipt(x, S, { kind: 'transfer', asset: a, amount: 2n, to: B }), /inscription amount must be 1/);
  assert.throws(() => encode({ genesis: G, sequence: 1n, op: { kind: 'transfer', asset: a, amount: 0n, to: B } }));
  // OFFER of 2 is rejected.
  const offer = { kind: 'offer', asset: a, amount: 2n, buyer: B, payout: S, price: 10n ** 12n, fee: saleFee(10n ** 12n), feeTo: FEE, expiry: x.state().height + 50 };
  const propose = { kind: 'propose', multisig: M, call: { kind: 'remark', event: false, payload: hex(encode({ genesis: G, sequence: seq(x, S), op: offer })) }, expiry: offer.expiry };
  rejected(x, receipt(S, hex(callBytes(propose)), [{ kind: 'created', multisig: M, proposal: 0, proposer: S }]), /inscription amount must be 1/);
  // Wallet preflight refuses the same.
  const s = x.state();
  assert.throws(() => preflight(s, G, S, { kind: 'mint', asset: a, amount: 1n }), /cannot be minted/);
  assert.throws(() => preflight(s, G, S, { kind: 'transfer', asset: a, amount: 2n, to: B }), /amount must be 1/);
  assert.throws(() => preflight(s, G, S, { kind: 'sell', multisig: M, offer: { ...offer, expiry: s.height + 300 } }), /amount must be 1/);
  assert.equal(parseCall(preflight(s, G, S, { kind: 'transfer', asset: a, amount: 1n, to: B }).call).kind, 'remark');
});

test('inscription transfer (free) and offer sale (1% fee) move it whole', () => {
  const x = new NativeIndexer(G);
  next(x, [receipt(S, '0x1300', [{ kind: 'multisig', id: M, signers: [C, B], threshold: 2 }])]);
  const a = inscribe(x);
  // Free transfer S -> C: a direct remark_with_event, no fee leg.
  const t = cmdReceipt(x, S, { kind: 'transfer', asset: a, amount: 1n, to: C });
  assert.equal(parseCall(fromHex(t.callHex)).kind, 'remark');
  assert.equal(qlyphsFee({ kind: 'transfer', asset: a, amount: 1n, to: C }), 0n);
  next(x, [t]);
  assert.equal(last(x), 'accepted');
  assert.equal(balanceOf(x.state(), a, S), 0n); assert.equal(balanceOf(x.state(), a, C), 1n);
  // The old holder can no longer move it.
  rejected(x, cmdReceipt(x, S, { kind: 'transfer', asset: a, amount: 1n, to: B }), /insufficient/);
  // C sells it to B through a bilateral offer; the buyer pays price + 1% fee to Qlyphs.
  const price = 5n * 10n ** 12n;
  const offer = { kind: 'offer', asset: a, amount: 1n, buyer: B, payout: C, price, fee: saleFee(price), feeTo: FEE, expiry: x.state().height + 50 };
  assert.equal(offer.fee, 5n * 10n ** 10n);
  const propose = { kind: 'propose', multisig: M, call: { kind: 'remark', event: false, payload: hex(encode({ genesis: G, sequence: seq(x, C), op: offer })) }, expiry: offer.expiry };
  next(x, [receipt(C, hex(callBytes(propose)), [{ kind: 'created', multisig: M, proposal: 0, proposer: C }])]);
  assert.equal(last(x), 'accepted');
  const ticket = x.state().tickets.get(ticketKey(M, 0));
  assert.equal(ticket.status, 'locked');
  assert.equal(balanceOf(x.state(), a, C), 0n, 'locked in the offer');
  assertInvariants(x.state());
  next(x, [receipt(B, hex(callBytes(buyCall(ticket))), [
    { kind: 'approved', multisig: M, proposal: 0, approver: B },
    { kind: 'paid', from: B, to: C, amount: price },
    { kind: 'paid', from: B, to: FEE, amount: offer.fee },
    { kind: 'batchCompleted' },
  ])]);
  const s = x.state();
  assert.equal(s.tickets.get(ticketKey(M, 0)).status, 'settled');
  assert.equal(balanceOf(s, a, B), 1n); assert.equal(balanceOf(s, a, C), 0n);
  assert.equal(s.assets.get(a).minted, 1n);
  assert.equal(s.inscriptions.get(a).creator, S, 'the creator is history, not the holder');
  assertInvariants(s);
});

test('unique symbols: DEPLOY rejects a taken symbol with no effect and no sequence advance', () => {
  const x = new NativeIndexer(G);
  const deploy = sym => ({ kind: 'deploy', symbol: sym, decimals: 6, cap: 1000n, limit: 500n, policy: 'open' });
  assert.equal(cmd(x, S, deploy('GLYPH')), 'accepted');
  const first = assetId(S, 0n);
  assert.equal(x.state().symbols.get('GLYPH'), first);
  // Another account, same symbol: rejected, fee leg not refunded, nothing else changes.
  rejected(x, cmdReceipt(x, B, deploy('GLYPH')), /^rejected: symbol taken$/);
  assert.equal(seq(x, B), 0n);
  // The creator itself cannot reuse it either.
  rejected(x, cmdReceipt(x, S, deploy('GLYPH')), /^rejected: symbol taken$/);
  // A would-be LAUNCH (reserved tag 4) is rejected as reserved and claims nothing.
  rejected(x, launchReceipt(x, B, 'GLYPH'), /^rejected: reserved operation$/);
  rejected(x, launchReceipt(x, B, 'PUMP'), /^rejected: reserved operation$/);
  assert.equal(cmd(x, B, deploy('PUMP')), 'accepted');
  rejected(x, cmdReceipt(x, C, deploy('PUMP')), /^rejected: symbol taken$/);
  // Close symbols are distinct; the rejected account's next valid claim uses sequence 0.
  assert.equal(cmd(x, C, deploy('GLYPH2')), 'accepted');
  assert.equal(x.state().symbols.get('GLYPH2'), assetId(C, 0n));
  assert.deepEqual([...x.state().symbols.keys()].sort(), ['GLYPH', 'GLYPH2', 'PUMP']);
  // Wallet preflight warns before signing.
  const s = x.state();
  assert.throws(() => preflight(s, G, X, deploy('GLYPH')), /symbol taken/);
  assert.throws(() => preflight(s, G, X, deploy('PUMP')), /symbol taken/);
  assert.equal(parseCall(preflight(s, G, X, deploy('FREE')).call).calls[1].amount, DEPLOY_FEE);
  // LAUNCH is not a command: the wallet cannot build one.
  assert.throws(() => parseCommand({ kind: 'launch', symbol: 'FREE' }), /unsupported command/);
  assertInvariants(s);
});

test('unique symbols: the first claim in block order wins; a rejected first claim reserves nothing', () => {
  const x = new NativeIndexer(G);
  const race = { kind: 'deploy', symbol: 'RACE', decimals: 0, cap: 5n, limit: 5n, policy: 'open' };
  next(x, [
    launchReceipt(x, S, 'RACE', 0),
    cmdReceipt(x, B, race, 1),
    cmdReceipt(x, C, race, 2),
  ]);
  const j = x.state().journal.slice(-3).map(v => v.verdict);
  assert.deepEqual(j, ['rejected: reserved operation', 'accepted', 'rejected: symbol taken']);
  assert.equal(x.state().symbols.get('RACE'), assetId(B, 0n));
  // A first claim with a short fee is rejected and does not reserve the symbol.
  const nextSym = { ...race, symbol: 'NEXT' };
  const bad = cmdReceipt(x, S, nextSym, 0);
  bad.events = feeEvents(S, DEPLOY_FEE - 1n);
  next(x, [bad, cmdReceipt(x, C, nextSym, 1)]);
  assert.deepEqual(x.state().journal.slice(-2).map(v => v.verdict).map(v => v.startsWith('rejected')), [true, false]);
  assert.equal(x.state().symbols.get('NEXT'), assetId(C, 0n));
  assertInvariants(x.state());
});

test('commands: parseCommand/buildCall/preflight for inscribe', () => {
  const c = parseCommand({ kind: 'inscribe', contentType: 'image/svg+xml', content: '0x3c73' });
  assert.deepEqual(c, { kind: 'inscribe', contentType: 'image/svg+xml', content: '0x3c73' });
  for (const bad of [
    { kind: 'inscribe', contentType: 'image/png' },
    { kind: 'inscribe', contentType: 'image/png', content: '0x00', extra: 1 },
    { kind: 'inscribe', contentType: 'IMAGE/PNG', content: '0x00' },
    { kind: 'inscribe', contentType: 'png', content: '0x00' },
    { kind: 'inscribe', contentType: 'image/png', content: '0x' },
    { kind: 'inscribe', contentType: 'image/png', content: '0xABCD' },
    { kind: 'inscribe', contentType: 'image/png', content: '00' },
    { kind: 'inscribe', contentType: 'image/png', content: '0x0' },
    { kind: 'inscribe', contentType: 'image/png', content: [0] },
    { kind: 'inscribe', contentType: 'image/png', content: '0x' + '00'.repeat(MAX_PAYLOAD + 1) },
  ]) assert.throws(() => parseCommand(bad), JSON.stringify(bad).slice(0, 80));
  const x = new NativeIndexer(G);
  const call = parseCall(preflight(x.state(), G, S, c).call);
  assert.equal(call.kind, 'batch');
  assert.deepEqual(call.calls[1], { kind: 'pay', to: FEE, amount: INSCRIBE_FEE });
  assert.deepEqual(decode(fromHex(call.calls[0].payload)), { genesis: G, sequence: 0n, op: c });
  // A payload over MAX_PAYLOAD cannot be built.
  assert.throws(() => buildCall(G, S, 0n, { ...c, content: '0x' + '00'.repeat(1000) }, undefined, undefined, LEGACY), /payload too large/);
});

test('checkpoint restore keeps symbols, inscriptions and the counter; bad checkpoints are refused', () => {
  const x = new NativeIndexer(G);
  inscribe(x); assert.equal(cmd(x, B, { kind: 'deploy', symbol: 'KEEP', decimals: 0, cap: 5n, limit: 5n, policy: 'open' }), 'accepted'); inscribe(x, C, 'text/plain', '0x61');
  const s = x.state();
  const y = NativeIndexer.fromCheckpoint(G, s);
  assert.deepEqual(y.state().inscriptions, s.inscriptions);
  assert.deepEqual(y.state().symbols, s.symbols);
  assert.equal(y.state().nextInscription, 3);
  // Invariants: counter mismatch, a symbol index that omits an asset, an inscription with supply 2.
  assert.throws(() => NativeIndexer.fromCheckpoint(G, { ...s, nextInscription: 7 }), /inscription counter invariant/);
  assert.throws(() => NativeIndexer.fromCheckpoint(G, { ...s, symbols: new Map() }), /symbol index invariant/);
  const doubled = structuredClone(s);
  doubled.assets.get(assetId(S, 0n)).minted = 2n; doubled.balances.set(`${assetId(S, 0n)}:${S}`, 2n);
  assert.throws(() => NativeIndexer.fromCheckpoint(G, doubled), /inscription asset invariant|supply/);
  const { symbols: _, ...legacy } = s;
  assert.throws(() => NativeIndexer.fromCheckpoint(G, legacy), /invalid checkpoint map/);
});
