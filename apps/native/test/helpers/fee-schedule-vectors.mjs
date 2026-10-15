// Deterministic generator of the shared fee schedule vectors (docs/native/vectors/fee-schedule.json),
// replayed by the TypeScript reducer here and by the independent Python verifier.
import {
  BLOCKED, ED, LEGACY_DEPLOY_FEE, LEGACY_INSCRIBE_FEE, LEGACY_RULES, MAINNET, MINT_FEE, RATE_MAX, RATE_MIN,
  TICKERS_DIGEST, assetId, callBytes, checkRate, decode, decodeOptions, encode, fee, feeAt, fromHex, hex,
} from '../../../../packages/native/src/index.ts';
import { snapshot, stateRoot } from '../../src/pq/checkpoint.ts';
import {
  DEV_GENESIS, FEE, adminOp, deployOp, feeRateOp, harness, id, inscribeOp,
} from '../../../../packages/native/test/helpers/fee-harness.mjs';
import { GUARDIAN, OPERATOR, SENTINEL, devAccount, feeRules, rulesWith } from '../../../../packages/native/test/helpers/fee-fixtures.mjs';
import { randomHistory as history } from '../../../../packages/native/test/helpers/fee-random.mjs';
import { unactivatedMainnet } from '../../../../packages/native/test/helpers/activated-mainnet.mjs';

// The release pins the mainnet activation, so mainnet's reading before it is generated on a copy of
// the reader with both pins null.
const unactivated = await unactivatedMainnet();
process.once('exit', unactivated.close);

const R = 10_000_000_000n;
const D = fee(inscribeOp(), R);
const WALLET_MAX_RATE = 40_000_000_000n;
const U = devAccount('user'), V = devAccount('user-2'), W = devAccount('user-3');
const NEWOP = devAccount('new-operator'), NEWG = devAccount('new-guardian'), NEWS = devAccount('new-sentinel');
const PO = devAccount('pending-operator'), PG = devAccount('pending-guardian'), X = devAccount('other');
// Short development windows keep the vectors small; they meet every bound of the rules.
const WIN = { delay: 400, grace: 320, guardianDelay: 400 };
const PROGRESSIVE = { progressive: { from: 1 }, progressiveV2: { from: 1 } };

/** JSON with every bigint as a decimal string. */
export const toJson = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

/** Runs `build` on a fresh chain and records its blocks, verdicts and state roots. */
function chainCase(name, rules, build, genesis = DEV_GENESIS, activation = { height: 0, hash: genesis }, make = harness) {
  const h = make(rules, genesis, activation);
  const verdicts = [], roots = [];
  let fees = JSON.stringify(toJson(h.state().fees));
  const block = h.block;
  // Every block is recorded: its verdicts, and its root when it carries receipts or changes the
  // fee state.
  h.block = (receipts = []) => {
    const b = block(receipts);
    for (const r of h.results(b)) verdicts.push({ height: b.height, ...r });
    const s = h.state(), now = JSON.stringify(toJson(s.fees));
    if (b.receipts.length > 0 || now !== fees) roots.push({ height: b.height, stateRoot: stateRoot(snapshot(s, genesis)) });
    fees = now;
    return b;
  };
  build(h);
  const s = h.state();
  if (roots.at(-1)?.height !== s.height) roots.push({ height: s.height, stateRoot: stateRoot(snapshot(s, genesis)) });
  return { name, genesis, activation, rules: toJson(rules), blocks: toJson(h.blocks), expect: { verdicts, roots } };
}
const P = (h) => h.height() + 1;
const gov = (h, signer, op) => h.block([h.remarkTx(signer, op)]);
const pay = (h, signer, op, amount, o) => h.block([h.feeTx(signer, op, amount, o)]);
const live = (h, from = 10) => { h.to(from); h.block(); };

function cases() {
  const out = [];
  out.push(chainCase('legacy rules on a development network read the fixed fees', LEGACY_RULES, (h) => {
    pay(h, U, deployOp('ABC'), LEGACY_DEPLOY_FEE);
    pay(h, U, { kind: 'mint', asset: assetId(U, 0n), amount: 5n }, MINT_FEE);
    pay(h, V, deployOp('DEF'), D);
    pay(h, V, inscribeOp(), LEGACY_INSCRIBE_FEE);
    pay(h, V, inscribeOp(), LEGACY_INSCRIBE_FEE + 1n);
    pay(h, W, deployOp('USDT'), LEGACY_DEPLOY_FEE); // no BLOCKED list in the legacy reading
  }));
  out.push(chainCase('mainnet without a fee schedule reads the legacy fees, as before the schedule', LEGACY_RULES, (h) => {
    pay(h, U, deployOp('ABC'), LEGACY_DEPLOY_FEE);
    pay(h, U, inscribeOp(), LEGACY_INSCRIBE_FEE);
    pay(h, U, { kind: 'mint', asset: assetId(V, 0n), amount: 1n }, MINT_FEE);
    pay(h, U, deployOp('ABC'), D, { to: V });
  }, MAINNET, { height: 102_161, hash: id(0x1021) }, unactivated.harness.harness));
  out.push(chainCase('fee checks under the schedule', rulesWith(feeRules({ ...WIN, legacyBefore: false }), PROGRESSIVE), (h) => {
    h.to(9);
    h.block([h.feeTx(U, deployOp('EARLY'), LEGACY_DEPLOY_FEE), h.feeTx(V, deployOp('EARLY'), D)]);
    h.block();
    let n = 0;
    for (const kind of ['deploy', 'deployProgressive', 'deployProgressiveV2']) {
      h.block(BLOCKED.map((s) => h.feeTx(devAccount(`blocked-${kind}-${s}`), deployOp(s, kind), D)));
      h.block(['USDT0', 'WBTC', 'QUANTUS', 'QLYP', 'DOGE', 'PEPE', 'DAI', 'M', 'BTC1', 'ETHS', 'USDCX'].map((s) => h.feeTx(devAccount(`allowed-${n++}`), deployOp(s + (kind === 'deploy' ? '' : kind === 'deployProgressive' ? 'A' : 'B'), kind), D)));
      h.block([h.feeTx(devAccount(`q-${kind}`), deployOp('Q', kind), 10n * D)]);
    }
    pay(h, U, deployOp('ABC'), D + 1n);
    pay(h, U, deployOp('ABC'), D - 1n);
    pay(h, U, deployOp('ABC'), LEGACY_DEPLOY_FEE);
    pay(h, U, deployOp('ABC'), D, { to: V });
    pay(h, U, deployOp('ABC'), D, { calls: (payload) => [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount: D }, { kind: 'pay', to: V, amount: 1n }] });
    pay(h, U, deployOp('ABC'), D, { events: [{ kind: 'remarked', sender: U }, { kind: 'paid', from: U, to: FEE, amount: D - 1n }, { kind: 'batchCompleted' }] });
    h.block([h.remarkTx(U, deployOp('ABC'))]);
    pay(h, U, deployOp('ABC'), D, { success: false, events: [] });
    h.block([h.feeTx(U, deployOp('ABC'), D), h.feeTx(V, deployOp('ABC'), D)]); // front-run
    h.block([h.feeTx(V, { kind: 'mint', asset: assetId(U, 0n), amount: 1n }, MINT_FEE), h.feeTx(W, { kind: 'mint', asset: assetId(U, 0n), amount: 1n }, 1_000_000_000n), h.feeTx(W, { kind: 'mint', asset: assetId(U, 0n), amount: 1n }, 20_000_000_000n)]);
    h.block([OPERATOR, SENTINEL, GUARDIAN].map((a, i) => h.feeTx(a, deployOp('ROLE' + i), D)));
    gov(h, GUARDIAN, adminOp('setOperator', W, P(h) + 400));
    pay(h, W, inscribeOp(), D);
  }));
  out.push(chainCase('governance checks', rulesWith(feeRules({ ...WIN, legacyBefore: false })), (h) => {
    h.to(9);
    h.block([h.remarkTx(OPERATOR, feeRateOp(500, 12_500_000_000n)), h.remarkTx(SENTINEL, adminOp('freeze'))]);
    // Tag 15 (reserved), with no body: rejected before any field is read.
    const tag15 = hex(encode({ genesis: DEV_GENESIS, sequence: 0n, op: adminOp('cancel') }).slice(0, 45)) + '0f';
    h.block([{ signer: U, callHex: hex(callBytes({ kind: 'remark', event: true, payload: tag15 })), success: true, events: [{ kind: 'remarked', sender: U }] }]);
    for (const [eff, rate] of [[399, 12_500_000_000n], [801, 12_500_000_000n], [400, RATE_MIN - 100n], [400, 12_340_000_000n], [400, 12_600_000_000n], [400, 7_990_000_000n], [400, 8_000_000_000n], [400, 12_500_000_000n], [800, 12_000_000_000n]])
      gov(h, OPERATOR, feeRateOp(P(h) + eff, rate));
    gov(h, U, feeRateOp(P(h) + 400, R));
    h.block([h.remarkTx(OPERATOR, feeRateOp(P(h) + 400, R), { wrap: (payload) => ({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to: FEE, amount: 0n }] }) })]);
    const ms = id(0x3333);
    h.block([h.remarkTx(SENTINEL, adminOp('freeze'), { wrap: (payload) => ({ kind: 'propose', multisig: ms, call: { kind: 'remark', event: false, payload }, expiry: 1000 }), events: [{ kind: 'created', multisig: ms, proposal: 0, proposer: SENTINEL }] })]);
    gov(h, U, adminOp('cancel'));
    for (const a of [OPERATOR, SENTINEL, GUARDIAN]) {
      gov(h, a, adminOp('cancel'));
      gov(h, OPERATOR, feeRateOp(P(h) + 400, 12_500_000_000n));
    }
    gov(h, GUARDIAN, adminOp('cancel'));
    gov(h, SENTINEL, adminOp('cancel'));
    gov(h, GUARDIAN, adminOp('setGuardian', PG, P(h) + 400));
    for (const a of [OPERATOR, GUARDIAN, SENTINEL, PG, '0x' + '00'.repeat(32), FEE]) gov(h, GUARDIAN, adminOp('setOperator', a, P(h) + 400));
    gov(h, GUARDIAN, adminOp('setOperator', PO, P(h) + 400));
    gov(h, GUARDIAN, adminOp('setOperator', PO, P(h) + 401));
    for (const a of [OPERATOR, SENTINEL, PO]) gov(h, GUARDIAN, adminOp('setGuardian', a, P(h) + 400));
    gov(h, GUARDIAN, adminOp('setGuardian', PG, P(h) + 401));
    for (const a of [OPERATOR, GUARDIAN, SENTINEL, PO, PG]) gov(h, GUARDIAN, adminOp('setSentinel', a));
    gov(h, U, adminOp('setOperator', GUARDIAN, 1));
    gov(h, GUARDIAN, adminOp('setOperator', SENTINEL, 1));
    gov(h, GUARDIAN, adminOp('setOperator', NEWOP, 1));
    gov(h, GUARDIAN, adminOp('setGuardian', GUARDIAN, 0));
    gov(h, GUARDIAN, adminOp('setGuardian', GUARDIAN, 0xffffffff));
    gov(h, U, adminOp('setGuardian', GUARDIAN, 0));
    gov(h, GUARDIAN, adminOp('setSentinel', X));
    gov(h, SENTINEL, adminOp('freeze'));
    gov(h, X, adminOp('freeze'));
    gov(h, GUARDIAN, adminOp('freeze'));
    gov(h, OPERATOR, feeRateOp(P(h) + 400, 12_500_000_000n));
    gov(h, GUARDIAN, adminOp('setOperator', OPERATOR, P(h) + 400));
    pay(h, PG, deployOp('PEND'), D);
  }));
  out.push(chainCase('windows: promotion, grace, roles after delay', rulesWith(feeRules({ ...WIN, legacyBefore: false })), (h) => {
    live(h);
    gov(h, OPERATOR, feeRateOp(411, 12_500_000_000n)); // P = 11
    gov(h, OPERATOR, feeRateOp(412, 12_000_000_000n)); // replaces it
    gov(h, GUARDIAN, adminOp('setOperator', NEWOP, 413));
    gov(h, GUARDIAN, adminOp('setGuardian', NEWG, 414));
    gov(h, GUARDIAN, adminOp('setSentinel', NEWS));
    h.to(412);
    h.block([h.feeTx(U, deployOp('NEW'), 300_000_000_000n), h.feeTx(V, deployOp('OLD'), D), h.feeTx(W, deployOp('MID'), 275_000_000_000n), h.feeTx(X, { kind: 'mint', asset: assetId(U, 0n), amount: 1n }, MINT_FEE)]);
    h.block([h.remarkTx(OPERATOR, feeRateOp(P(h) + 400, 12_000_000_000n)), h.remarkTx(NEWOP, feeRateOp(P(h) + 400, 12_000_000_000n))]);
    h.block([h.remarkTx(NEWOP, feeRateOp(P(h) + 400, 12_000_000_000n)), h.remarkTx(GUARDIAN, adminOp('setSentinel', X)), h.remarkTx(NEWG, adminOp('setSentinel', X))]);
    h.to(412 + 320 - 1);
    pay(h, U, inscribeOp(), D);
    pay(h, U, inscribeOp(), D);
    pay(h, U, inscribeOp(), 300_000_000_000n);
  }));
  out.push(chainCase('the legacy window below and after from', rulesWith(feeRules({ ...WIN, legacyBefore: true })), (h) => {
    h.to(9);
    h.block([h.feeTx(U, deployOp('OLD'), LEGACY_DEPLOY_FEE), h.feeTx(V, deployOp('NEW'), D)]);
    h.block([h.feeTx(V, deployOp('NEW'), D), h.feeTx(W, inscribeOp(), LEGACY_INSCRIBE_FEE)]);
    h.to(10 + 320 - 1);
    pay(h, U, inscribeOp(), LEGACY_INSCRIBE_FEE);
    pay(h, U, inscribeOp(), LEGACY_INSCRIBE_FEE);
  }));
  out.push(chainCase('a reset at `at`', rulesWith(feeRules({ ...WIN, legacyBefore: false, resets: [{ at: 20, operator: NEWOP, guardian: NEWG, sentinel: NEWS }] })), (h) => {
    live(h);
    gov(h, OPERATOR, feeRateOp(P(h) + 400, 12_500_000_000n));
    gov(h, GUARDIAN, adminOp('setOperator', U, P(h) + 400));
    gov(h, SENTINEL, adminOp('freeze'));
    h.to(20);
    h.block([h.remarkTx(OPERATOR, feeRateOp(420, 12_500_000_000n)), h.remarkTx(NEWOP, feeRateOp(420, 12_500_000_000n)), h.remarkTx(NEWS, adminOp('cancel'))]);
  }));
  return out;
}
function encodings() {
  const rules = toJson(rulesWith(feeRules()));
  const env = (op, sequence = 7n) => ({ genesis: DEV_GENESIS, sequence, op });
  const out = [];
  const add = (name, bytes, height = 10) => {
    const h = hex(bytes);
    let ok = true, value;
    try {
      value = toJson(decode(fromHex(h), decodeOptions(rulesWith(feeRules()), height)).op);
    } catch (e) {
      ok = false;
      value = e.message;
    }
    out.push({ name, hex: h, height, rules, ok, ...(ok ? { op: value } : { error: value }) });
  };
  const rate = encode(env(feeRateOp(0x01020304, R)));
  add('FEE_RATE', rate);
  add('FEE_RATE with a trailing byte', Uint8Array.from([...rate, 0]));
  add('FEE_RATE truncated', rate.slice(0, -1));
  const actions = [adminOp('cancel'), adminOp('freeze'), adminOp('setOperator', NEWOP, 600), adminOp('setGuardian', NEWG, 601), adminOp('setSentinel', NEWS)];
  for (const op of actions) {
    const b = encode(env(op));
    add(`FEE_ADMIN ${op.action}`, b);
    add(`FEE_ADMIN ${op.action} with a trailing byte`, Uint8Array.from([...b, 0]));
    for (const body of [0, 32, 36].filter((n) => n !== b.length - 47))
      add(`FEE_ADMIN ${op.action} with a ${body}-byte body`, Uint8Array.from([...b.slice(0, 47), ...new Uint8Array(body)]));
  }
  const five = encode(env(adminOp('cancel'))); five[46] = 5;
  add('FEE_ADMIN action 5', five);
  add('FEE_RATE before from', rate, 9);
  add('FEE_ADMIN before from', encode(env(adminOp('freeze'))), 9);
  const reserved = encode(env(adminOp('cancel'))).slice(0, 46); reserved[45] = 15;
  add('tag 15', reserved);
  add('tag 15 before from', reserved, 9);
  return out;
}

function fees() {
  const out = [];
  for (const rate of [RATE_MIN, R, RATE_MAX, WALLET_MAX_RATE]) {
    for (const kind of ['deploy', 'deployProgressive', 'deployProgressiveV2'])
      for (const symbol of ['Q', 'ABC', 'ABCDEFGHIJKL']) out.push({ kind, symbol, rate: String(rate), fee: String(fee(deployOp(symbol, kind), rate)) });
    out.push({ kind: 'inscribe', rate: String(rate), fee: String(fee(inscribeOp(), rate)) });
  }
  // The existential-deposit floor, reached only by a target below every real one.
  out.push({ kind: 'target', cents: '1', rate: String(RATE_MIN), fee: String(feeAt(1n, RATE_MIN)) });
  if (feeAt(1n, RATE_MIN) !== ED) throw new Error('ED floor');
  return out;
}

export function generateVectors() {
  return {
    format: 1,
    cases: cases(),
    encodings: encodings(),
    fees: fees(),
    checkRate: [RATE_MIN, RATE_MAX, RATE_MIN - 100n, RATE_MAX + 100_000_000n, 12_300_000_000n, 12_340_000_000n].map((r) => ({ rate: String(r), ok: checkRate(r) })),
    tickersDigest: TICKERS_DIGEST,
  };
}
/** The file's exact bytes: one case block per line, so that diffs stay readable. */
export function vectorsText(v = generateVectors()) {
  const lines = ['{', `  "format": ${v.format},`, '  "cases": ['];
  v.cases.forEach((c, i) => {
    const { blocks, ...head } = c;
    lines.push('    {');
    lines.push(`      "head": ${JSON.stringify(head)},`);
    lines.push('      "blocks": [');
    blocks.forEach((b, j) => lines.push(`        ${JSON.stringify(b)}${j < blocks.length - 1 ? ',' : ''}`));
    lines.push('      ]');
    lines.push(`    }${i < v.cases.length - 1 ? ',' : ''}`);
  });
  lines.push('  ],');
  for (const key of ['encodings', 'fees', 'checkRate']) {
    lines.push(`  "${key}": [`);
    v[key].forEach((x, i) => lines.push(`    ${JSON.stringify(x)}${i < v[key].length - 1 ? ',' : ''}`));
    lines.push('  ],');
  }
  lines.push(`  "tickersDigest": ${JSON.stringify(v.tickersDigest)}`, '}', '');
  return lines.join('\n');
}
/** Reads the file back into the documented shape: each case is {name, genesis, activation, rules,
 * blocks, expect}. */
export function parseVectors(text) {
  const v = JSON.parse(text);
  return { ...v, cases: v.cases.map(({ head, blocks }) => ({ ...head, blocks })) };
}
/** A random history as JSON for the Python property run: blocks, rules and, per wallet operation,
 * the block it was priced at, its rate and where it landed (all accepted by the TypeScript reducer). */
export function randomHistory(seed, opts) {
  const r = history(seed, opts);
  return toJson({
    genesis: r.genesis,
    activation: { height: 0, hash: r.genesis },
    rules: r.rules,
    blocks: r.blocks,
    wallet: r.wallet.map((w) => ({ priced: w.a, rate: w.rate, height: w.height, index: w.index, amount: w.amount })),
  });
}
