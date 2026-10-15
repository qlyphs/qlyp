// Mainnet blocks of today's operations, and how a reader reads them: verdicts and a state digest
// per block. The pinned reading in ../fixtures/mainnet-legacy-reading.json was produced by the
// reader that ran before the fee schedule existed; a reader without a reviewed fee schedule must
// reproduce it.
//
//   node --experimental-strip-types legacy-reader.mjs PATH/TO/src/index.ts OUT.json
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAINNET = '0xfb5487c0be6ae4ade2d41d16e50465129861636c2b8d61fa94d7a19631626fba';
export const ANCHOR = { height: 102_161, hash: id(0xa0) };
/** The fixed fees of today, written out so that the blocks do not depend on the reader's constants. */
const DEPLOY = 1_000_000_000_000n,
  INSCRIBE = 100_000_000_000n,
  MINT = 10_000_000_000n;
const A = id(0xa1),
  B = id(0xb1),
  FEE = '0x2139a57532fbf4764ad95754c17545fed7af915fb008b6494b02e503084da8b3';

export function id(n) {
  return '0x' + BigInt(n).toString(16).padStart(64, '0');
}
const le = (n, bytes) => {
  let out = '';
  for (let i = 0; i < bytes; i++) out += Number((BigInt(n) >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
  return out;
};
/** A payload with any tag, written by hand: a reader that does not know the tag must reject it. */
const rawPayload = (sequence, tag, body) => '0x514c595001' + MAINNET.slice(2) + le(sequence, 8) + le(tag, 1) + body;

/** The blocks, built with `lib` (a reader's index.ts): its encoder and call builder. */
export function legacyBlocks(lib) {
  const seq = new Map();
  const next = (who) => {
    const s = seq.get(who) ?? 0n;
    seq.set(who, s + 1n);
    return s;
  };
  const payload = (who, op, sequence = next(who)) => lib.hex(lib.encode({ genesis: MAINNET, sequence, op }));
  const batch = (who, p, amount, o = {}) => ({
    signer: who,
    callHex: lib.hex(lib.callBytes({ kind: 'batch', calls: [{ kind: 'remark', event: true, payload: p }, { kind: 'pay', to: o.to ?? FEE, amount }] })),
    success: o.success ?? true,
    events: o.success === false ? [] : [{ kind: 'remarked', sender: who }, { kind: 'paid', from: who, to: o.to ?? FEE, amount }, { kind: 'batchCompleted' }],
  });
  const remark = (who, p) => ({
    signer: who,
    callHex: lib.hex(lib.callBytes({ kind: 'remark', event: true, payload: p })),
    success: true,
    events: [{ kind: 'remarked', sender: who }],
  });
  const deploy = (symbol) => ({ kind: 'deploy', symbol, decimals: 0, cap: 1000n, limit: 100n, policy: 'open' });
  const inscribe = (content) => ({ kind: 'inscribe', contentType: 'text/plain', content });
  const first = lib.assetId(A, 0n);
  const receipts = [
    // Accepted today: the exact legacy fees, MINT, a free TRANSFER.
    [batch(A, payload(A, deploy('FIRST')), DEPLOY)],
    [batch(A, payload(A, inscribe('0x6869')), INSCRIBE)],
    [batch(A, payload(A, { kind: 'mint', asset: first, amount: 100n }), MINT), remark(A, payload(A, { kind: 'transfer', asset: first, amount: 40n, to: B }))],
    // A symbol the fee schedule will block, and a lookalike: both are ordinary symbols today.
    [batch(B, payload(B, deploy('USDT')), DEPLOY), batch(B, payload(B, deploy('USDT0')), DEPLOY)],
    // Rejected today: a rate-like fee, a wrong recipient, an inscription paying the deploy fee.
    [
      batch(B, payload(B, deploy('CHEAP'), seq.get(B)), 250_000_000_000n),
      batch(B, payload(B, deploy('WRONG'), seq.get(B)), DEPLOY, { to: id(0xf1) }),
      batch(B, payload(B, inscribe('0x01'), seq.get(B)), DEPLOY),
    ],
    // A taken symbol (the fee is paid and kept), a failed batch, a deploy outside a fee batch.
    [batch(B, payload(B, deploy('FIRST'), seq.get(B)), DEPLOY)],
    [batch(A, payload(A, deploy('FAILS'), seq.get(A)), DEPLOY, { success: false })],
    [remark(A, payload(A, deploy('BARE'), seq.get(A)))],
    // Tags not active on mainnet: progressive DEPLOYs and the fee schedule's tags 13 and 14.
    [
      batch(A, payload(A, { kind: 'deployProgressive', symbol: 'PROG', decimals: 0, cap: 1000n }, seq.get(A)), DEPLOY),
      batch(A, payload(A, { kind: 'deployProgressiveV2', symbol: 'PROGB', decimals: 0, cap: 1000n }, seq.get(A)), DEPLOY),
      remark(A, rawPayload(seq.get(A), 13, le(102_200, 4) + le(10_000_000_000n, 8))),
      remark(A, rawPayload(seq.get(A), 14, '01')),
      remark(A, rawPayload(seq.get(A), 4, '')),
    ],
    // A wrong sequence, then the next valid deploy and inscription.
    [batch(A, payload(A, deploy('LATE'), 99n), DEPLOY)],
    [batch(A, payload(A, deploy('LATE')), DEPLOY), batch(B, payload(B, inscribe('0x6869')), INSCRIBE)],
  ];
  let parent = ANCHOR.hash;
  return receipts.map((rs, i) => {
    const height = ANCHOR.height + 1 + i;
    const hash = id(0xb10c0000 + height);
    const block = {
      height,
      hash,
      parent,
      spec: 152,
      txVersion: 6,
      finalized: height,
      receipts: rs.map((r, index) => ({ index, hash: id(0x7e000000 + height * 16 + index), ...r })),
    };
    parent = hash;
    return block;
  });
}

/** Deterministic text of a reader state: maps as sorted entries, bigints as decimal strings. */
export function canonicalState(v) {
  if (typeof v === 'bigint') return JSON.stringify('n' + v);
  if (v instanceof Map)
    return canonicalState([...v].sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)));
  if (Array.isArray(v)) return '[' + v.map(canonicalState).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalState(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
/** The digest of a state as the reader of today defines it: a reader with a fee schedule adds
 * `fees`, which must be null here and is left out. */
export function stateDigest(s) {
  const { fees, ...today } = s;
  if (fees !== undefined && fees !== null) throw Error('fee state where today has none');
  return createHash('sha256').update(canonicalState(today)).digest('hex');
}
/** Reads `blocks` with `lib`'s mainnet reader at its default rules. */
export function reading(lib, blocks) {
  const x = new lib.NativeIndexer(MAINNET, ANCHOR, false);
  return blocks.map((b) => {
    x.apply(b);
    const s = x.state();
    return { height: b.height, verdicts: s.journal.filter((j) => j.height === b.height).map((j) => [j.index, j.verdict]), digest: stateDigest(s) };
  });
}
/** JSON with bigints as {"$n": "decimal"}. */
export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $n: String(x) } : x), 1) + '\n';
export const fromJson = (text) => JSON.parse(text, (_, x) => (x && typeof x === 'object' && typeof x.$n === 'string' && Object.keys(x).length === 1 ? BigInt(x.$n) : x));

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [index, out] = process.argv.slice(2);
  if (!index || !out) throw Error('usage: legacy-reader.mjs PATH/TO/src/index.ts OUT.json');
  const lib = await import(pathToFileURL(index).href);
  const blocks = legacyBlocks(lib);
  writeFileSync(out, toJson({ anchor: ANCHOR, blocks, reading: reading(lib, blocks) }));
}
