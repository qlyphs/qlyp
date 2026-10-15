// A deterministic chain harness for fee schedule tests: blocks, fee batches and governance remarks.
import {
  NativeIndexer, callBytes, encode, feeBatchCall, feeKept, hex, QLYPHS_FEE_ACCOUNT,
} from '../../src/index.ts';

export const FEE = QLYPHS_FEE_ACCOUNT;
export const id = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
/** A development genesis: anything but mainnet. */
export const DEV_GENESIS = id(0xde7);
export const ACTIVATION = (genesis) => ({ height: 0, hash: genesis });

const symbolOf = (op) => ('symbol' in op ? op.symbol : undefined);
export const deployOp = (symbol, kind = 'deploy') =>
  kind === 'deploy'
    ? { kind, symbol, decimals: 0, cap: 1000n, limit: 1000n, policy: 'open' }
    : { kind, symbol, decimals: 0, cap: 1000n };
export const inscribeOp = (content = '0x01') => ({ kind: 'inscribe', contentType: 'text/plain', content });
export const feeRateOp = (effective, rate) => ({ kind: 'feeRate', effective, rate: BigInt(rate) });
export const adminOp = (action, account, effective) =>
  action === 'cancel' || action === 'freeze'
    ? { kind: 'feeAdmin', action }
    : action === 'setSentinel'
      ? { kind: 'feeAdmin', action, account }
      : { kind: 'feeAdmin', action, account, effective };

/** A chain under `rules`. Every block is final when applied, so each has a state root. */
export function harness(rules, genesis = DEV_GENESIS, activation = ACTIVATION(genesis), hashBase = 0xb10c00000n) {
  const x = new NativeIndexer(genesis, activation, false, rules);
  let serial = 0n;
  const blocks = [];
  const nextHash = () => id(hashBase + ++serial);
  const h = {
    x,
    genesis,
    rules,
    blocks,
    state: () => x.state(),
    height: () => x.state().height,
    seq: (a) => x.state().sequences.get(a) ?? 0n,
    /** Applies the next block; receipts get their index from their position. */
    block(receipts = []) {
      const s = x.state();
      const b = {
        height: s.height + 1,
        hash: nextHash(),
        parent: s.hash,
        spec: 152,
        txVersion: 6,
        finalized: s.height + 1,
        receipts: receipts.map((r, index) => ({ hash: nextHash(), ...r, index: r.index ?? index })),
      };
      x.apply(b);
      blocks.push(b);
      return b;
    },
    /** Empty blocks until the next block is `height`. */
    to(height) {
      while (x.state().height < height - 1) h.block();
    },
    /** The verdicts of the last block, with the fee kept flag. */
    results(b = blocks.at(-1)) {
      const s = x.state();
      return b.receipts.map((r) => {
        const j = s.journal.find((e) => e.height === b.height && e.index === r.index);
        const verdict = j ? j.verdict : null;
        return { index: r.index, verdict, feeKept: feeKept(r, verdict, rules, b.height) };
      });
    },
    last: () => x.state().journal.at(-1)?.verdict,
    /** A fee batch for `op`, paying `amount` (or another shape through `o`). */
    feeTx(signer, op, amount, o = {}) {
      const sequence = o.seq ?? h.seq(signer);
      const payload = hex(encode({ genesis, sequence, op }));
      const to = o.to ?? FEE;
      const call = o.call ?? (o.calls ? { kind: 'batch', calls: o.calls(payload) } : { kind: 'batch', calls: [{ kind: 'remark', event: true, payload }, { kind: 'pay', to, amount }] });
      const events = o.events ?? [
        { kind: 'remarked', sender: signer },
        { kind: 'paid', from: signer, to, amount },
        { kind: 'batchCompleted' },
      ];
      return { signer, callHex: hex(callBytes(call)), success: o.success ?? true, events, ...(o.index !== undefined ? { index: o.index } : {}) };
    },
    /** A direct remark_with_event of a governance (or any) operation. */
    remarkTx(signer, op, o = {}) {
      const sequence = o.seq ?? h.seq(signer);
      const payload = hex(encode({ genesis, sequence, op }));
      const call = o.wrap ? o.wrap(payload) : { kind: 'remark', event: true, payload };
      return { signer, callHex: hex(callBytes(call)), success: o.success ?? true, events: o.events ?? [{ kind: 'remarked', sender: signer }] };
    },
    /** One block with one receipt; returns its verdict. */
    one(r) {
      h.block([r]);
      return h.results()[0].verdict;
    },
  };
  return h;
}
export { symbolOf, feeBatchCall };
