/** Test-only public-next-lot state machine; not imported by any deployed reducer. */
import { createHash } from 'node:crypto';
import { progressiveMintQuote } from '../../src/progressive-mint.ts';

const MAX_U32 = 0xffff_ffff;
const ZERO = '0x' + '00'.repeat(32);
const DOMAIN = Buffer.from('Qlyphs/ProgressiveMint/right/v1\0', 'ascii');
const need = (ok, message) => { if (!ok) throw new Error(message); };
const bytes = (hex, size) => {
  need(typeof hex === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(hex), 'noncanonical hex');
  const value = Buffer.from(hex.slice(2), 'hex');
  need(size === undefined || value.length === size, 'wrong byte length');
  return value;
};
const natural = (n) => need(Number.isSafeInteger(n) && n >= 0 && n <= MAX_U32 && !Object.is(n, -0), 'invalid position');
const decimal = (s) => {
  need(typeof s === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(s), 'noncanonical amount');
  return BigInt(s);
};
const uint = (n, width) => {
  need(typeof n === 'bigint' && n >= 0n && n < (1n << BigInt(8 * width)), 'integer overflow');
  return Buffer.from(Array.from({ length: width }, (_, i) => Number((n >> BigInt(8 * i)) & 255n)));
};
const hex = (b) => '0x' + b.toString('hex');
function compact(n) {
  need(n >= 0n && n < (1n << 128n), 'compact overflow');
  if (n < 64n) return uint(n << 2n, 1);
  if (n < 16384n) return uint((n << 2n) | 1n, 2);
  if (n < (1n << 30n)) return uint((n << 2n) | 2n, 4);
  let width = 4;
  while (n >= (1n << BigInt(8 * width))) width++;
  return Buffer.concat([Buffer.from([((width - 4) << 2) | 3]), uint(n, width)]);
}

/** Synthetic starting state, including a pre-issued balance for boundary tests. Not a DEPLOY. */
export function fixtureState({ genesis, asset, cap, feeTo, anchor, minted = '0', holder = ZERO }) {
  bytes(genesis, 32); bytes(asset, 40); bytes(feeTo, 32); bytes(holder, 32);
  need(feeTo !== ZERO, 'zero fee recipient');
  natural(anchor.height); natural(anchor.index); bytes(anchor.hash, 32);
  progressiveMintQuote(decimal(cap), decimal(minted));
  const state = {
    genesis, asset, cap, minted, feeTo,
    height: anchor.height, hash: anchor.hash,
    anchor: minted === cap ? null : structuredClone(anchor),
    balances: minted === '0' ? {} : { [holder]: minted },
    sequences: {},
    collected: '0',
  };
  assertState(state);
  return state;
}

export function assertState(s) {
  natural(s.height); bytes(s.hash, 32); bytes(s.asset, 40); bytes(s.genesis, 32); bytes(s.feeTo, 32);
  need(s.feeTo !== ZERO, 'zero fee recipient');
  const q = progressiveMintQuote(decimal(s.cap), decimal(s.minted));
  const balance = Object.entries(s.balances).reduce((total, [id, value]) => {
    bytes(id, 32); return total + decimal(value);
  }, 0n);
  need(balance === decimal(s.minted), 'supply conservation');
  decimal(s.collected);
  need((s.anchor === null) === (q.remainingLots === 0n), 'right/exhaustion mismatch');
  if (s.anchor !== null) {
    natural(s.anchor.height); natural(s.anchor.index); bytes(s.anchor.hash, 32);
    need(s.anchor.height <= s.height, 'future anchor');
    if (s.anchor.height === s.height) need(s.anchor.hash === s.hash, 'anchor/head mismatch');
  }
}

/** A token-specific, lot-specific domain excludes cross-asset reuse and reuse by other tickets. */
export function nextRight(s) {
  assertState(s);
  const q = progressiveMintQuote(decimal(s.cap), decimal(s.minted));
  if (q.nextFee === null) return null;
  const namespace = createHash('sha512').update(Buffer.concat([
    DOMAIN, bytes(s.genesis, 32), bytes(s.asset, 40), uint(q.mintedLots, 2),
  ])).digest().subarray(0, 32);
  const signers = [hex(namespace), s.anchor.hash].sort();
  need(signers[0] !== signers[1], 'ticket signer collision');
  return {
    asset: s.asset, lot: String(q.mintedLots + 1n), amount: String(q.lotSize),
    fee: String(q.nextFee), feeTo: s.feeTo, signers,
    threshold: 2, nonce: String(s.anchor.index), anchor: structuredClone(s.anchor),
  };
}

/** The pinned call layout; a real node's metadata must encode the same bytes. */
export function creationHex(right) {
  return hex(Buffer.concat([
    Buffer.from([19, 0]), compact(2n), ...right.signers.map((x) => bytes(x, 32)),
    uint(2n, 4), uint(decimal(right.nonce), 8),
  ]));
}
export function settlementHex(right) {
  return hex(Buffer.concat([
    Buffer.from([9, 2]), compact(2n), bytes(creationHex(right)),
    Buffer.from([2, 3, 0]), bytes(right.feeTo, 32), compact(decimal(right.fee)),
  ]));
}
export function sameTicket(event, right) {
  return event.kind === 'created' && event.threshold === 2 && event.nonce === right.nonce &&
    Array.isArray(event.signers) && event.signers.length === 2 &&
    event.signers.every((signer, i) => signer === right.signers[i]);
}

/** Consume lifecycle events even for wrappers; only an exact direct batch credits a lot. */
function applyReceipt(s, block, receipt) {
  const right = nextRight(s);
  if (!right) return;
  const created = receipt.events.filter((event) => sameTicket(event, right));
  if (!created.length) return;
  need(created.length === 1, 'duplicate native ticket creation');
  need(block.height > right.anchor.height, 'same-block ticket consumption');
  const relevant = receipt.events.filter((e) => ['created', 'paid', 'completed'].includes(e.kind));
  const [creation, payment, completed] = relevant;
  const canonical = receipt.success === true && receipt.signer !== null && receipt.signer !== ZERO &&
    receipt.signer !== s.feeTo && receipt.callHex === settlementHex(right) &&
    relevant.length === 3 && creation === created[0] && creation.creator === receipt.signer &&
    payment?.kind === 'paid' && payment.from === receipt.signer && payment.to === right.feeTo &&
    payment.amount === right.fee && completed?.kind === 'completed';
  if (canonical) {
    bytes(receipt.signer, 32);
    s.minted = String(decimal(s.minted) + decimal(right.amount));
    s.balances[receipt.signer] = String(decimal(s.balances[receipt.signer] ?? '0') + decimal(right.amount));
    s.collected = String(decimal(s.collected) + decimal(right.fee));
  }
  // Rotation is driven by the native permanent marker, never by a clock or a user reservation.
  s.anchor = s.minted === s.cap ? null : { height: block.height, hash: block.hash, index: receipt.index };
}

/** Detached candidate: rejected blocks do not leave a partially advanced checkpoint. */
export function applyBlock(state, block) {
  assertState(state); natural(block.height); bytes(block.hash, 32); bytes(block.parent, 32);
  need(block.height === state.height + 1 && block.parent === state.hash && block.hash !== block.parent,
    'noncontiguous block');
  need(Array.isArray(block.receipts), 'invalid receipts');
  const next = structuredClone(state);
  next.height = block.height; next.hash = block.hash;
  let previous = -1;
  for (const r of block.receipts) {
    natural(r.index); need(r.index > previous, 'unordered receipts'); previous = r.index;
    need(r.signer === null || (typeof r.signer === 'string' && /^0x[0-9a-f]{64}$/.test(r.signer)), 'invalid signer');
    need(typeof r.success === 'boolean' && Array.isArray(r.events), 'invalid receipt');
    bytes(r.callHex);
    applyReceipt(next, block, r);
  }
  assertState(next);
  return next;
}
