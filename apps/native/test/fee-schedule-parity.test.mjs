// The independent Python verifier against the TypeScript reducer on the fee schedule: the shared
// vectors and seeded random histories must give the same state root at every block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAINNET, NativeIndexer, TICKERS_DIGEST, checkRules } from '../../../packages/native/src/index.ts';
import { canonical, snapshot, stateRoot } from '../src/pq/checkpoint.ts';
import { PythonReducer } from '../src/pq/python.ts';
import { parseVectors, randomHistory } from './helpers/fee-schedule-vectors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = resolve(here, '..');
const FILE = resolve(here, '../../../docs/native/vectors/fee-schedule.json');
const v = parseVectors(readFileSync(FILE, 'utf8'));
const verifier = (script = resolve(nativeDir, 'verifier/replay.py')) => new PythonReducer(script);
/** Block JSON back to reducer input: amounts and nonces are bigints again. */
const tsBlock = (b) => ({
  ...b,
  receipts: b.receipts.map((r) => ({
    ...r,
    events: r.events.map((e) =>
      e.kind === 'paid' ? { ...e, amount: BigInt(e.amount) } : e.kind === 'multisig' && e.nonce !== undefined ? { ...e, nonce: BigInt(e.nonce) } : e,
    ),
  })),
});
/** Python state roots, one per block. */
async function pythonRoots(c, py = verifier()) {
  const roots = new Map();
  try {
    await py.request({ kind: 'init', genesis: c.genesis, activation: c.activation, rules: c.rules });
    for (const block of c.blocks) roots.set(block.height, stateRoot(await py.request({ kind: 'block', block })));
  } finally {
    py.close();
  }
  return roots;
}

for (const c of v.cases.filter((c) => c.genesis !== MAINNET))
  test(`Python replays the vector: ${c.name}`, async () => {
    const roots = await pythonRoots(c);
    assert.equal(roots.size, c.blocks.length);
    for (const r of c.expect.roots) assert.equal(roots.get(r.height), r.stateRoot, `height ${r.height}`);
  });

test('Python refuses legacy rules on mainnet, and with that check lifted reads the mainnet vector like TypeScript', async () => {
  const c = v.cases.find((x) => x.genesis === MAINNET);
  assert.ok(c);
  await assert.rejects(pythonRoots(c), /independent verifier stopped/);
  // The same rules with the review gate lifted in-process, to compare the reading of the blocks:
  // without a schedule mainnet reads the legacy fees, as before the fee schedule existed.
  const script = `
import json, sys
sys.path.insert(0, 'verifier')
import replay
replay.mainnet_rules_allowed = lambda *a: True
c = json.loads(sys.stdin.read())
ledger = replay.Ledger(c['genesis'], c['activation'], c['rules'])
for b in c['blocks']:
    ledger.advance(b)
    print(json.dumps(ledger.snapshot()))`;
  const run = spawnSync('python3', ['-I', '-c', script], { cwd: nativeDir, input: JSON.stringify(c), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const snaps = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
  for (const r of c.expect.roots) assert.equal(stateRoot(snaps[c.blocks.findIndex((b) => b.height === r.height)]), r.stateRoot);
});

test('Python-only units against the vectors: codec, fees, rates, digest, strict rules', () => {
  const run = spawnSync('python3', ['-I', resolve(here, 'fee_schedule_witness.py'), FILE, TICKERS_DIGEST], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ok \d+\n$/);
});

test('replay.py refuses an init without the TypeScript tickers digest, or with another one', async () => {
  const c = v.cases[0];
  for (const tickersDigest of [undefined, '0'.repeat(128), TICKERS_DIGEST.toUpperCase()]) {
    const py = verifier();
    const init = { kind: 'init', genesis: c.genesis, activation: c.activation, rules: c.rules, tickersDigest };
    // python.ts fills in a missing digest, so the field is sent as null to test its absence.
    await assert.rejects(py.request(tickersDigest === undefined ? { ...init, tickersDigest: null } : init), /independent verifier stopped/);
    py.close();
  }
  // The digest python.ts adds by default is accepted.
  const py = verifier();
  try {
    const s = await py.request({ kind: 'init', genesis: c.genesis, activation: c.activation, rules: c.rules });
    assert.equal(s.format, 2);
    assert.equal(s.fees, null);
  } finally {
    py.close();
  }
});

/** TypeScript and Python states, block by block, over a seeded random history. Equal canonical
 * snapshots are equal state roots; hashing every block would only slow the run down. Returns how
 * many blocks had a previous grid in force. */
async function compare(seed, opts) {
  const r = randomHistory(seed, opts);
  assert.ok(r.wallet.length > 0);
  const x = new NativeIndexer(r.genesis, r.activation, false, checkRules(r.rules));
  const py = verifier();
  let promoted = 0;
  try {
    await py.request({ kind: 'init', genesis: r.genesis, activation: r.activation, rules: r.rules });
    for (const block of r.blocks) {
      x.apply(tsBlock(block));
      const s = x.state();
      const ours = (py.last = await py.request({ kind: 'block', block }));
      assert.equal(canonical(ours), canonical(snapshot(s, r.genesis)), `seed ${seed}, height ${block.height}`);
      if (s.fees?.previous) promoted++;
    }
    assert.equal(stateRoot(py.last), stateRoot(snapshot(x.state(), r.genesis)));
  } finally {
    py.close();
  }
  return promoted;
}

test('seeded random histories with development windows: same roots at every block', { timeout: 300000 }, async () => {
  let promoted = 0;
  for (const seed of [1, 2, 3]) promoted += await compare(seed, { blocks: 3000, walletRate: 0.03 });
  // Not vacuous: grids were promoted, so both engines read overlap windows, and every wallet
  // operation the TypeScript reducer accepted is in the Python state too (the states cover assets).
  assert.ok(promoted > 0, 'no promotion');
});

test('a seeded random history with mainnet windows and the third-party era bound', { timeout: 600000 }, async () => {
  // The options of the TypeScript property run, so both engines read the same history.
  const promoted = await compare(11, { windows: 'mainnet', blocks: 16_000, period: 4096, maxBirthOffset: 512, walletRate: 0.006, govRate: 0.004 });
  assert.ok(promoted > 0, 'no promotion');
});
