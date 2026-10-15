// The u32 bounds of the fee state in both engines: the last grid id, the FEE_RATE refused after it,
// and the configured heights and windows. TypeScript and Python must give the same verdicts and states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeIndexer, checkFeeRules } from '../../../packages/native/src/index.ts';
import { applyFeeRate, genesisFeeState } from '../../../packages/native/src/fee-schedule.ts';
import { canonical, snapshot } from '../src/pq/checkpoint.ts';
import { DEV_GENESIS, adminOp, deployOp, feeRateOp, harness, id } from '../../../packages/native/test/helpers/fee-harness.mjs';
import { GUARDIAN, OPERATOR, SENTINEL, devAccount, feeRules, rulesWith } from '../../../packages/native/test/helpers/fee-fixtures.mjs';

const nativeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX = 0xffffffff;
const LAST_GRID_ID = MAX - 1;
const D = 250_000_000_000n; // the DEPLOY fee at 1e10
const U = devAccount('user');
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Runs `body` in the Python verifier directory with `input` as `data`; returns its printed JSON. */
function python(body, input) {
  const script = `import json, sys\nsys.path.insert(0, 'verifier')\nimport fee_schedule as fs, replay\ndata = json.loads(sys.stdin.read())\n${body}`;
  const run = spawnSync('python3', ['-I', '-c', script], { cwd: nativeDir, input: json(input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
const verdict = (fn) => {
  try {
    return fn();
  } catch (e) {
    return 'rejected: ' + e.message;
  }
};
const gridJson = (g) => (g === null ? null : { ...g, rate: g.rate.toString() });
const feesJson = (f) => ({ ...f, current: gridJson(f.current), previous: gridJson(f.previous), pending: gridJson(f.pending) });

test('applyFeeRate at the last grid id: same verdicts and states in TypeScript and Python', () => {
  const rules = feeRules();
  const g = genesisFeeState(rules);
  const op = (effective, rate) => feeRateOp(effective, rate);
  const cases = [
    [{ ...g, nextGrid: LAST_GRID_ID }, OPERATOR, op(610, 11_000_000_000n)],
    [{ ...g, nextGrid: MAX }, OPERATOR, op(610, 11_000_000_000n)],
    [{ ...g, nextGrid: MAX, operator: null }, OPERATOR, op(610, 11_000_000_000n)],
    [{ ...g, nextGrid: MAX }, GUARDIAN, op(610, 11_000_000_000n)],
    [{ ...g, nextGrid: MAX }, OPERATOR, op(609, 11_000_000_000n)],
    [{ ...g, nextGrid: MAX }, OPERATOR, op(610, 20_000_000_000n)],
  ];
  const ts = cases.map(([fees, signer, o]) => verdict(() => feesJson(applyFeeRate(fees, rules, signer, o, 10, 3))));
  assert.equal(ts[0].pending.id, LAST_GRID_ID);
  assert.equal(ts[0].nextGrid, MAX);
  assert.deepEqual(ts.slice(1), [
    'rejected: grid ids exhausted',
    'rejected: fee operator frozen',
    'rejected: not the fee operator',
    'rejected: invalid effective height',
    'rejected: rate step too large',
  ]);
  const py = python(
    `rules = fs.parse_fee_rules(data['rules'])
def grid(g):
    return None if g is None else dict(g, rate=int(g['rate']))
out = []
for fees, signer, op in data['cases']:
    fees = dict(fees, current=grid(fees['current']), previous=grid(fees['previous']), pending=grid(fees['pending']))
    op = dict(op, rate=int(op['rate']))
    try:
        out.append(fs.snapshot_fees(fs.apply_fee_rate(fees, rules, signer, op, 10, 3)))
    except ValueError as e:
        out.append('rejected: ' + str(e))
print(json.dumps(out))`,
    { rules, cases: cases.map(([fees, signer, o]) => [feesJson(fees), signer, o]) },
  );
  // Python names rate errors differently; every verdict compared here is a shared string.
  assert.deepEqual(py, ts);
});

test('replay past the last grid id: a refused FEE_RATE, then the block goes on; same states in both engines', () => {
  const rules = rulesWith(feeRules());
  const h = harness(rules);
  h.to(10);
  h.block();
  const s = h.state();
  s.fees.nextGrid = LAST_GRID_ID - 1;
  const x = NativeIndexer.fromCheckpoint(DEV_GENESIS, s, false, rules);
  const blocks = [];
  const tx = (signer, op, seq) => h.remarkTx(signer, op, { seq });
  const block = (receipts) => {
    const t = x.state();
    const n = BigInt(blocks.length + 1);
    const b = {
      height: t.height + 1, hash: id(0xe0000000n + n * 0x100n), parent: t.hash, spec: 152, txVersion: 6, finalized: t.height + 1,
      receipts: receipts.map((r, index) => ({ hash: id(0xe0000000n + n * 0x100n + BigInt(index) + 1n), ...r, index })),
    };
    x.apply(b);
    blocks.push(b);
    return b.receipts.map((r) => x.state().journal.find((e) => e.height === b.height && e.index === r.index)?.verdict);
  };
  const states = [];
  const p = 11;
  const run = (receipts, expected) => {
    assert.deepEqual(block(receipts), expected);
    states.push(canonical(snapshot(x.state(), DEV_GENESIS)));
  };
  run([tx(OPERATOR, feeRateOp(p + 600, 11_000_000_000n), 0n), tx(OPERATOR, feeRateOp(p + 600, 12_000_000_000n), 1n)], ['accepted', 'accepted']);
  assert.equal(x.state().fees.pending.id, LAST_GRID_ID);
  run(
    [tx(OPERATOR, feeRateOp(p + 601, 12_000_000_000n), 2n), h.feeTx(U, deployOp('ABC'), D, { seq: 0n }), tx(OPERATOR, feeRateOp(p + 601, 12_000_000_000n), 2n)],
    ['rejected: grid ids exhausted', 'accepted', 'rejected: grid ids exhausted'],
  );
  assert.equal(x.state().sequences.get(OPERATOR), 2n);
  run([tx(SENTINEL, adminOp('cancel'), 0n), tx(OPERATOR, feeRateOp(p + 602, 12_000_000_000n), 2n)], ['accepted', 'rejected: grid ids exhausted']);
  assert.equal(x.state().fees.pending, null);

  const py = python(
    `ledger = replay.Ledger(data['genesis'], data['activation'], data['rules'])
for b in data['before']:
    ledger.advance(b)
ledger.fees['nextGrid'] = data['nextGrid']
out = []
for b in data['after']:
    ledger.advance(b)
    out.append(ledger.snapshot())
print(json.dumps(out))`,
    { genesis: DEV_GENESIS, activation: { height: 0, hash: DEV_GENESIS }, rules, before: h.blocks, nextGrid: LAST_GRID_ID - 1, after: blocks },
  );
  assert.deepEqual(py.map((v) => canonical(v)), states);
});

test('configured heights and windows: the same u32 bounds in checkFeeRules and parse_fee_rules', () => {
  const reset = (at) => ({ at, operator: devAccount('o2'), guardian: devAccount('g2'), sentinel: devAccount('s2') });
  const cases = [
    [feeRules({ from: MAX - 1200 }), true],
    [feeRules({ from: MAX - 1199 }), false],
    [feeRules({ from: MAX }), false],
    [feeRules({ from: 2 ** 32 }), false],
    [feeRules({ guardianDelay: (MAX - 11) / 2 }), true],
    [feeRules({ guardianDelay: (MAX - 9) / 2 }), false],
    [feeRules({ guardianDelay: Number.MAX_SAFE_INTEGER }), false],
    [feeRules({ from: MAX - 100_800, delay: 7200, grace: 4608, guardianDelay: 50_400 }), true],
    [feeRules({ from: MAX - 100_799, delay: 7200, grace: 4608, guardianDelay: 50_400 }), false],
    [feeRules({ resets: [reset(MAX)] }), true],
    [feeRules({ resets: [reset(MAX + 1)] }), false],
  ];
  const ts = cases.map(([f]) => verdict(() => (checkFeeRules(f), true)) === true);
  assert.deepEqual(ts, cases.map(([, ok]) => ok));
  const py = python(
    `out = []
for f in data:
    try:
        fs.parse_fee_rules(f)
        out.append(True)
    except ValueError:
        out.append(False)
print(json.dumps(out))`,
    cases.map(([f]) => f),
  );
  assert.deepEqual(py, ts);
});
