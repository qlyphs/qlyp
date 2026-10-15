/** Test-only lifecycle and independent replay checks; synthetic dispatch is not native evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyBlock, assertState, creationHex, fixtureState, nextRight, settlementHex } from './helpers/progressive-settlement-model.mjs';

const id = (byte) => '0x' + byte.repeat(32);
const A = id('aa'), B = id('bb'), F = id('ee'), G = id('11'), H = id('ff');
const hash = (text) => '0x' + createHash('sha256').update(text).digest('hex');
const asset = (index = 0) => A + index.toString(16).padStart(16, '0');
const initial = (count = 0, index = 0, cap = '1000000') => fixtureState({
  genesis: G, asset: asset(index), cap, minted: String(BigInt(cap) / 1000n * BigInt(count)),
  feeTo: F, holder: H, anchor: { height: 1, hash: hash('anchor'), index: 4 },
});
const block = (s, receipts, salt = '') => ({
  height: s.height + 1, parent: s.hash, hash: hash(s.hash + String(s.height + 1) + salt),
  receipts: receipts.map((r, index) => ({ ...r, index })),
});
const creation = (r, creator) => ({ kind: 'created', creator, signers: [...r.signers], threshold: 2, nonce: r.nonce });
const payment = (r, from) => ({ kind: 'paid', from, to: r.feeTo, amount: r.fee });
const canonical = (r, signer = A) => ({ index: 0, signer, success: true,
  callHex: settlementHex(r), events: [creation(r, signer), payment(r, signer), { kind: 'completed' }] });

/** Assumes the documented atomic, permanent-marker primitive; only a real node can verify it. */
class SyntheticRuntime {
  markers = new Set();
  collected = 0n;
  execute(r, signer = A, { mode = 'pay', fee = r.fee } = {}) {
    const key = creationHex(r);
    const result = { index: 0, signer, success: true, callHex: settlementHex({ ...r, fee }), events: [] };
    if (this.markers.has(key) || mode === 'payment-failure') {
      result.success = false;
      return result;
    }
    this.markers.add(key);
    result.events.push(creation(r, signer));
    if (mode === 'burn' || mode === 'partial-wrapper') {
      result.callHex = mode === 'burn' ? creationHex(r) : '0x0900' + creationHex(r).slice(2);
      return result;
    }
    this.collected += BigInt(fee);
    result.events.push(payment({ ...r, fee }, signer), { kind: 'completed' });
    return result;
  }
}

for (const count of [199, 399, 599, 799, 999]) {
  for (const order of [[A, B], [B, A]]) {
    test(`competing payments at completed lot ${count}, first ${order[0].slice(2, 4)}`, () => {
      const start = initial(count), r = nextRight(start), runtime = new SyntheticRuntime();
      const receipts = order.map((who) => runtime.execute(r, who));
      const out = applyBlock(start, block(start, receipts));
      assert.equal(out.minted, String((count + 1) * 1000));
      assert.equal(out.balances[order[0]], '1000');
      assert.equal(out.balances[order[1]], undefined);
      assert.equal(runtime.collected, BigInt(r.fee));
      assert.equal(receipts[1].success, false);
      assert.deepEqual(receipts[1].events, []);
      assert.equal(out.collected, r.fee);
      assert.equal(nextRight(out)?.fee ?? null, count === 999 ? null : String(BigInt(r.fee) + 100_000_000_000n));
    });
  }
}

test('stale right fails even after a new right becomes available', () => {
  const start = initial(199), old = nextRight(start), runtime = new SyntheticRuntime();
  const out = applyBlock(start, block(start, [runtime.execute(old)]));
  const fresh = nextRight(out);
  assert.notEqual(creationHex(fresh), creationHex(old));
  const stale = runtime.execute(old, B);
  const next = applyBlock(out, block(out, [stale]));
  assert.equal(stale.success, false);
  assert.equal(next.minted, out.minted);
  assert.equal(next.collected, out.collected);
  assert.deepEqual(next.anchor, out.anchor);
});

for (const mode of ['burn', 'partial-wrapper']) {
  test(`${mode} rotates without minting, and later stale payment loses no issuance fee`, () => {
    const start = initial(199), old = nextRight(start), runtime = new SyntheticRuntime();
    const first = runtime.execute(old, B, { mode });
    const cancelled = applyBlock(start, block(start, [first]));
    assert.equal(cancelled.minted, start.minted);
    assert.equal(cancelled.collected, '0');
    assert.equal(nextRight(cancelled).fee, old.fee);
    assert.notEqual(creationHex(nextRight(cancelled)), creationHex(old));
    const late = runtime.execute(old);
    assert.equal(late.success, false);
    const out = applyBlock(cancelled, block(cancelled, [late]));
    assert.equal(out.collected, '0');
    const recovered = applyBlock(out, block(out, [runtime.execute(nextRight(out))]));
    assert.equal(recovered.minted, '200000');
    assert.equal(recovered.collected, old.fee);
  });
}

test('payment failure rolls back the assumed marker and allows retry of the same right', () => {
  const start = initial(999), r = nextRight(start), runtime = new SyntheticRuntime();
  const failed = runtime.execute(r, A, { mode: 'payment-failure' });
  const out = applyBlock(start, block(start, [failed]));
  assert.equal(runtime.markers.size, 0);
  assert.deepEqual(nextRight(out), r);
  const retry = applyBlock(out, block(out, [runtime.execute(r)]));
  assert.equal(retry.minted, retry.cap);
  assert.equal(nextRight(retry), null);
});

test('idle blocks never expire, reprice, or reserve the current right', () => {
  let state = initial(199); const first = nextRight(state);
  for (let n = 0; n < 2000; n++) state = applyBlock(state, block(state, []));
  assert.deepEqual(nextRight(state), first);
  assert.equal(state.minted, '199000');
});

test('separate QLYP sequence changes do not invalidate settlement', () => {
  const start = initial(199), right = nextRight(start);
  start.sequences[A] = '18446744073709551614';
  const out = applyBlock(start, block(start, [canonical(right)]));
  assert.equal(out.minted, '200000');
  assert.deepEqual(out.sequences, start.sequences);
});

test('unrelated lifecycle events do not rotate the active right', () => {
  const start = initial(199), foreign = nextRight(initial(199, 1));
  const out = applyBlock(start, block(start, [canonical(foreign)]));
  assert.equal(out.minted, start.minted);
  assert.deepEqual(out.anchor, start.anchor);
});

test('cross-asset, cross-network, cross-lot and other ticket domains are distinct', () => {
  const start = initial(199);
  const foreignNetwork = { ...start, genesis: id('22') };
  const candidates = [nextRight(start), nextRight(initial(199, 1)), nextRight(initial(200)), nextRight(foreignNetwork)];
  assert.equal(new Set(candidates.map(creationHex)).size, 4);
  for (const r of candidates) assert.notDeepEqual(r.signers, [A, start.anchor.hash].sort());
});

test('one wrapper may rotate multiple assets without creating colliding next tickets', () => {
  const one = initial(199), two = initial(199, 1);
  const r1 = nextRight(one), r2 = nextRight(two);
  const receipt = { index: 0, signer: B, success: true, callHex: '0x0900',
    events: [creation(r1, B), creation(r2, B)] };
  const b = block(one, [receipt]);
  const s1 = applyBlock(one, b), s2 = applyBlock(two, b);
  assert.deepEqual(s1.anchor, s2.anchor);
  assert.notEqual(creationHex(nextRight(s1)), creationHex(nextRight(s2)));
  assert.equal(s1.collected, '0'); assert.equal(s2.collected, '0');
});

for (const mutate of [
  (r) => { r.events.reverse(); },
  (r) => { r.events[0].creator = B; },
  (r) => { r.events[1].from = B; },
  (r) => { r.events[1].amount = '1'; },
  (r) => { r.events[1].to = B; },
  (r) => { r.events.push({ kind: 'completed' }); },
  (r) => { r.events.splice(1, 0, { ...r.events[1] }); },
  (r) => { r.callHex += '00'; },
  (r) => { r.success = false; },
  (r) => { r.signer = null; },
]) {
  test(`noncanonical consuming receipt rotates without credit: ${mutate.toString()}`, () => {
    const start = initial(199), r = canonical(nextRight(start)); mutate(r);
    const out = applyBlock(start, block(start, [r]));
    assert.equal(out.minted, start.minted);
    assert.equal(out.collected, '0');
    assert.notDeepEqual(out.anchor, start.anchor);
  });
}

test('a manually mispriced payment is NOT a safe official mint; it may move funds without credit', () => {
  const start = initial(199), runtime = new SyntheticRuntime();
  const receipt = runtime.execute(nextRight(start), A, { fee: '1' });
  const out = applyBlock(start, block(start, [receipt]));
  assert.equal(runtime.collected, 1n);
  assert.equal(out.collected, '0');
  assert.equal(out.minted, start.minted);
});

test('no per-user reservations accumulate under repeated cancellations', () => {
  let state = initial(199); const runtime = new SyntheticRuntime();
  const fields = Object.keys(state).sort();
  for (let n = 0; n < 3000; n++) {
    state = applyBlock(state, block(state, [runtime.execute(nextRight(state), B, { mode: 'burn' })]));
    assert.deepEqual(Object.keys(state).sort(), fields);
    assert.equal(Object.keys(state.balances).length, 1);
  }
  assert.equal(state.minted, '199000');
  assert.equal(state.collected, '0');
  assert.equal(runtime.markers.size, 3000); // Native tombstones grow: no hidden zero-storage claim.
});

test('complete issuance collects exactly the profile total and keeps one active right at most', () => {
  let state = initial(); const runtime = new SyntheticRuntime();
  for (let n = 0; n < 1000; n++) state = applyBlock(state, block(state, [runtime.execute(nextRight(state))]));
  assert.equal(state.minted, state.cap);
  assert.equal(state.collected, '300000000000000');
  assert.equal(runtime.collected, 300000000000000n);
  assert.equal(state.anchor, null);
});

test('restart and permitted fork replay agree; abandoned-branch quotes are not finality-safe', () => {
  const start = initial(199), right = nextRight(start);
  const forkA = block(start, [canonical(right, A)], 'A');
  const forkB = block(start, [canonical(right, B)], 'B');
  const a = applyBlock(start, forkA), b = applyBlock(start, forkB);
  assert.notDeepEqual(a.balances, b.balances);
  assert.notEqual(creationHex(nextRight(a)), creationHex(nextRight(b)));
  const restored = JSON.parse(JSON.stringify(start));
  assert.deepEqual(applyBlock(restored, forkB), b);
  assert.throws(() => applyBlock(a, forkB), /noncontiguous block/);
});

test('parent, ordering and duplicate lifecycle failures cannot partially mutate the checkpoint', () => {
  const start = initial(199), saved = structuredClone(start), r = canonical(nextRight(start));
  const bad = block(start, [r, r]);
  bad.receipts[1].index = 0;
  assert.throws(() => applyBlock(start, bad), /unordered receipts/);
  assert.deepEqual(start, saved);
  const duplicate = structuredClone(r); duplicate.events.push(structuredClone(r.events[0]));
  assert.throws(() => applyBlock(start, block(start, [duplicate])), /duplicate native ticket creation/);
  assert.deepEqual(start, saved);
});

test('same-block prediction of a newly anchored ticket fails closed on synthetic input', () => {
  const start = initial(199), first = block(start, [canonical(nextRight(start))]);
  const after = applyBlock(start, first);
  first.receipts.push({ ...canonical(nextRight(after), B), index: 1 });
  assert.throws(() => applyBlock(start, first), /same-block ticket consumption/);
});

test('terminal state has no ticket and cannot be restored as a live right', () => {
  const s = initial(1000);
  assert.equal(nextRight(s), null);
  s.anchor = { height: s.height, hash: s.hash, index: 4 };
  assert.throws(() => assertState(s), /right\/exhaustion mismatch/);
});

test('fixed ticket/call vectors prevent a common JS/Python hash or encoding mistake', () => {
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/progressive-settlement.json', import.meta.url), 'utf8'));
  for (const v of oracle) {
    const r = nextRight(v.state);
    assert.deepEqual(r, v.right);
    assert.equal(settlementHex(r), v.callHex);
  }
});

test('independent Python matches lifecycle, right derivation and exact call bytes', () => {
  const cases = [];
  for (const cap of ['1000', '1000000', '21000000000000000000000000']) {
    for (const count of [0, 1, 198, 199, 200, 398, 399, 400, 598, 599, 600, 798, 799, 800, 998, 999, 1000]) {
      const state = initial(count, 0, cap), right = nextRight(state);
      cases.push({ state });
      if (!right) continue;
      for (const mode of ['pay', 'burn', 'partial-wrapper', 'payment-failure']) {
        const runtime = new SyntheticRuntime(), receipt = runtime.execute(right, A, { mode });
        const b1 = block(state, [receipt, runtime.execute(right, B)]);
        cases.push({ state, blocks: [b1] });
        const after = applyBlock(state, b1), next = nextRight(after);
        if (next) cases.push({ state, blocks: [b1, block(after, [runtime.execute(next, B)])] });
      }
    }
  }
  let state = initial(), runtime = new SyntheticRuntime();
  for (let n = 0; n < 1000; n++) {
    const b = block(state, [runtime.execute(nextRight(state), n % 2 ? A : B)]);
    cases.push({ state, blocks: [b] });
    state = applyBlock(state, b);
  }
  const results = cases.map(({ state, blocks = [] }) => {
    const output = blocks.reduce(applyBlock, state), right = nextRight(output);
    return { state: output, right, callHex: right ? settlementHex(right) : null };
  });
  const script = fileURLToPath(new URL('./helpers/progressive-settlement-witness.py', import.meta.url));
  const run = spawnSync('python3', [script], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.deepEqual(JSON.parse(run.stdout), results);
  console.log(`Independent lifecycle parity: ${cases.length} cases agree`);
});

for (const order of [['A', 'B', 'burn'], ['A', 'burn', 'B'], ['B', 'A', 'burn'], ['B', 'burn', 'A'], ['burn', 'A', 'B'], ['burn', 'B', 'A']]) {
  test(`native-assumption schedule ${order.join(' / ')} never charges a losing supported payment`, () => {
    const start = initial(999), right = nextRight(start), runtime = new SyntheticRuntime();
    const receipts = order.map((action) => runtime.execute(right, action === 'A' ? A : B,
      { mode: action === 'burn' ? 'burn' : 'pay' }));
    const out = applyBlock(start, block(start, receipts));
    const minted = order[0] === 'burn' ? 0 : 1;
    assert.equal(out.minted, String(999000 + minted * 1000));
    assert.equal(runtime.collected, BigInt(minted) * BigInt(right.fee));
    assert.equal(out.collected, String(runtime.collected));
    for (const receipt of receipts.slice(1)) assert.deepEqual(receipt.events, []);
  });
}
