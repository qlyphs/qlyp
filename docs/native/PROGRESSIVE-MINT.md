# Progressive mint: progressive-1000-v1 and -v2

**Status: part of QLYP-v1 behind an explicit activation height. On Quantus mainnet,
progressive-1000-v2 runs from block 218,350, the reviewed activation (section 5);
progressive-1000-v1 never does. Development networks use their configured heights.** Existing tokens, their DEPLOY and MINT bytes,
their mint limits and their 0.01 QTC mint fee are unchanged.

The settlement design is in [PROGRESSIVE-MINT-SETTLEMENT.md](PROGRESSIVE-MINT-SETTLEMENT.md). The
protocol summary is [SPEC.md section 6](SPEC.md#6-progressive-mint-progressive-1000-v1-and--v2).

## 1. Frozen profiles

The token supply is divided into exactly 1,000 identical lots. One mint buys exactly one lot.
There is no creator-selected curve, fee schedule, lot count, mint limit, issuer exemption,
partial mint, multiple-lot shortcut, creator fee or pre-mint.

| Completed lots before the mint | Next lot numbers | Qlyphs fee per lot | Atomic QTC |
| --- | --- | --- | --- |
| 0 through 199 | 1 through 200 | 0.10 QTC | 100000000000 |
| 200 through 399 | 201 through 400 | 0.20 QTC | 200000000000 |
| 400 through 599 | 401 through 600 | 0.30 QTC | 300000000000 |
| 600 through 799 | 601 through 800 | 0.40 QTC | 400000000000 |
| 800 through 999 | 801 through 1,000 | 0.50 QTC | 500000000000 |
| 1,000 | none | mint closed | null |

1 QTC = 10^12 atomic units. This is the complete Qlyphs mint fee of a progressive asset, replacing
the legacy 0.01 QTC rather than adding to it. For a complete issuance:

`200 * (0.10 + 0.20 + 0.30 + 0.40 + 0.50) = 300 QTC`,

whatever the supply: 1M, 21M or 100M tokens have the same 1,000 fee steps; only the size of a lot
changes. Deployment (the DEPLOY fee of the [fee schedule](../extension/PROTOCOL-FEES.md)), network fees and the native ticket cost
are separate. The fee goes to
the existing Qlyphs fee account. The market stays usable while minting is open: minted lots
transfer and sell like any other token.

The [fee schedule](../extension/PROTOCOL-FEES.md) (on mainnet from block 218,350, with progressive-1000-v2)
prices the deploy of tags 11 and 12
like DEPLOY (a flat 25 USD for every allowed symbol, 0.25 QTC at 100 USD per QTC), and rejects a
deploy of one of the six BLOCKED symbols, `BTC ETH QLYPHS QTC USDC USDT` (`symbol blocked`). Lot fees stay the frozen QTC amounts of each profile (v2: 210 QTC
in all); a USD-pegged lot profile would be a new tag and
activation. It shares the progressive-1000-v2 mainnet activation height. Before that height mainnet
keeps reading the deploys and INSCRIBE at the legacy fees, and for the schedule's grace window
after it for mortal eras within the bounds of the fee schedule spec (sections 5.5 and 6.3), so the
schedule changes no state or fee of an earlier mainnet block.

**progressive-1000-v2** (tag 12) keeps every rule above and changes only the fees:

| Next lot numbers | Qlyphs fee per lot | Atomic QTC |
| --- | --- | --- |
| 1 through 200 | 0.01 QTC | 10000000000 |
| 201 through 400 | 0.10 QTC | 100000000000 |
| 401 through 600 | 0.20 QTC | 200000000000 |
| 601 through 800 | 0.30 QTC | 300000000000 |
| 801 through 1,000 | 0.44 QTC | 440000000000 |

`200 * (0.01 + 0.10 + 0.20 + 0.30 + 0.44) = 210 QTC`. On the mainnet runtime (spec 153) the first lot
costs about 0.014 QTC in all: 0.01 to Qlyphs, the 0.003 QTC native ticket and about 0.001 QTC of
network fee. The development runtime charges ten times those native costs (about 0.05 QTC in all).

Each profile is frozen: tag 11 always means `progressive-1000-v1` and tag 12
`progressive-1000-v2`. Another schedule needs a new operation tag and its own activation; changing
a profile's constants would reprice existing tokens.

## 2. Integer contract

All quantities are atomic units. Let `C` be the maximum supply and `S` the minted quantity.

- `0 < C <= 2^128 - 1` and `C % 1000 == 0`; `L = C / 1000` is the exact lot size.
- `0 <= S <= C` and `S % L == 0`; `i = S / L` is the number of minted lots, in `[0, 1000]`.
- If `i == 1000` there is no next fee and no mint. Otherwise the fee is row `floor(i / 200)`.

The fee is read from the supply *before* the mint: lot 200 costs 0.10 QTC, lot 201 costs 0.20. A lot
cannot straddle a tier. Transfers and sales may split lots; lots bound issuance, not ownership.

TypeScript accepts bigint quantities only, Python exact ints only (not bool). No floating point,
rounding, u128 overflow or silently capped final lot is possible.

## 3. Protocol

**PROGRESSIVE DEPLOY**, tag 11 (progressive-1000-v1), and **PROGRESSIVE DEPLOY V2**, tag 12
(progressive-1000-v2): `symbol Vec<u8>, decimals u8, cap u128`. Each pays the DEPLOY fee
([fee schedule](../extension/PROTOCOL-FEES.md)) in the usual fee batch and shares the symbol namespace with DEPLOY. The reducer rejects a cap that does
not split into 1,000 whole lots. Tags 4 to 8 and tag 10 stay reserved for future operations; a
legacy tag is never reinterpreted.

**PROGRESSIVE MINT** is not a QLYP payload. Each progressive asset has one current right, anchored
at `{height, blockHash, extrinsicIndex}` of its DEPLOY or of the last use of the previous right. The
right is the multisig `(sort([namespace, anchor.blockHash]), 2, anchor.extrinsicIndex)` with

```
namespace = first_32_bytes(SHA512(
    ASCII("Qlyphs/ProgressiveMint/right/v1\0") || genesis[32] || assetId[40] || u16_le(minted lots)))
```

(`right/v2` for a progressive-1000-v2 token: a ticket of one profile is never a right of the other)

and the only settlement is the signer's own

```
utility.batch_all([
    multisig.create_multisig(signers, 2, nonce),
    balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, lot fee)
])
```

byte for byte, whose receipt shows exactly one creation of that ticket by the signer, one payment of
the lot fee from the signer to Qlyphs and one batchCompleted. It credits one lot to the signer. Any
other creation of the ticket (bare, through `multisig.execute`, underpaid, reordered, extra calls)
credits nothing. Every use ends the right; the next one is anchored at that extrinsic, or none after
lot 1,000. A right cannot be used in the block that creates it, and the Qlyphs fee account cannot
mint. A legacy MINT of a progressive asset is rejected; a legacy asset has no right.

**State.** The only new persisted field is the progressive asset's `right` anchor (or null once all
lots are minted). The definition is `{symbol, decimals, cap, limit: cap / 1000, policy}`, with policy
`'progressive'` or `'progressive-v2'`, committed as its canonical tag-11 or tag-12 bytes. Lot number, tier, fee and progress are
derived from `minted`. Tickets are tracked by their asset's anchor, not stored as multisigs, so
attested state does not grow with mints. Invariants: whole lots, `limit == cap / 1000`, a right
exactly while lots remain, its anchor at or below the current block (and in the current block only
with its hash). A legacy asset carries no `right`.

**Activation.** Rules are explicit: `{ progressive, progressiveV2 }`, each `null` or `{ from:
height }`, never read from a checkpoint or a block. Before its `from`, a profile's tag is `rejected:
unknown operation` exactly as before and no right of that profile exists. A reader must not set,
move or remove an activation at or below its finalized checkpoint, or within 512 blocks above it: a
lot may be signed from a tip attestation up to 256 blocks above finality and stays valid for its
256-block era, so no block that a signed lot may rely on is ever read under other rules. On mainnet
a configured activation is refused: the activations are constants of the code (section 5).

**Journal.** A canonical settlement is `accepted`. Any other use of a current right is `rejected:
progressive mint right used without its exact settlement; no lot minted`. A settlement-shaped
payment that uses no current right is `rejected: not the current progressive mint right; no lot
minted`, and a failed one is `rejected: progressive mint failed natively; no Qlyphs fee was paid`.

## 4. Wallet

A lot is signed at the tip of the chain, from the state both pinned witnesses attest at a recent
best block X (a tip attestation: QPA1 statements under their own domain, fresh challenge, never
usable as a finalized checkpoint). The wallet picks X, its node's best block (if the witnesses
cannot attest it yet, one more try a second later on the best block then, never an older block),
derives the
next lot and its exact call itself, and signs that call with a mortal era born exactly at X. The
signature is then valid only on chains that contain X, hence the attested state: there the right is
either still current, so the lot is minted, or already used, so the payment fails natively before
any QTC moves. No finality wait is needed for the right, and the wallet races other buyers at the
tip.

The review shows the token, `lot n / 1000`, the tokens received, the Qlyphs fee, the network fee
estimate, the burned native ticket, the minting progress after the lot, the mint right it consumes
and the attested block. A client builds the call itself from the attested state at X; a call or
fee quoted by anyone else must equal it, and right before signing the signing context must still be
the attested block. A newer view of the chain may only make the client refuse (a lot already
taken). The dapp names the lot it showed (`mintProgressive { asset, lot, profile }`, the profile
defaulting to `progressive-1000-v1`); a different lot or profile is refused. A lot mint involves no
refund, custody, reserve or AMM.

A lot taken after signing fails on chain before any QTC moves, so the signer pays only the network
fee. What the wallet cannot protect: a manually built payment for a right that is not the current
one, or in another shape, or signed with an era older than the right, is accepted by the runtime and
may mint nothing; and it relies on its pinned witnesses being honest about the state at X.

## 5. Mainnet activation

Mainnet runs progressive-1000-v2 from block 218,350, and never progressive-1000-v1.

- **One value.** `MAINNET_PROGRESSIVE_V2_FROM` in `packages/native/src/protocol.ts`, mirrored in
  `apps/native/verifier/replay.py`, is the first mainnet block whose tag-12 DEPLOYs count: 218,350,
  with the fee schedule (`MAINNET_FEE_SCHEDULE`) at the same height, and a test pins that. A mainnet
  reader runs these rules by default and accepts no others, legacy rules included.
- **No configuration can switch it on.** On mainnet the reducer accepts only `mainnetRules()`:
  legacy rules while the value is `null`, otherwise progressive-1000-v2 from that height, which must
  come after QLYP's activation block. A height configured for a mainnet reader is refused.
- **The witnesses bind it.** `protocol.ts` and the rules are inputs of the rules hash, so a mainnet
  witness policy names this exact activation.
- **With the value `null`**, as in releases before the activation, no mainnet trust policy or
  snapshot exists (`snapshotState()` refuses one) and the Python verifier does not read mainnet.
- **With the value set**, a mainnet policy must start at QLYP's activation block and name both
  witnesses' implementations. A mainnet wallet build accepts a policy only when it matches the
  pins (genesis, activation block, runtime) and the reviewed rules. Witnesses refuse a policy that
  differs from their pins.

One rule holds once the value is set:
- **No way back.** Never set the value back to `null`, nor move it, to stop a running mint: lots
  already signed or paid would be read differently. A suspension stops new authorizations; it never changes how blocks
  already used are read.

## 6. Implementation and tests

- `packages/native/src/progressive-mint.ts`: pricing, lot fee, ticket derivation, exact settlement
  bytes and the settlement reader. `protocol.ts` applies them; `codec.ts` holds tags 11 and 12.
  `sha512.ts` is a dependency-free SHA-512 (FIPS 180-4) for the ticket namespace, tested against
  OpenSSL, so that the protocol package keeps no dependency.
- `apps/native/verifier/progressive_mint.py` and `replay.py`: the independent Python rules, written
  from this document; `rpc.py` decodes the multisig creator and nonce itself.
- Mainnet activation: `packages/native/test/mainnet-activation.test.mjs` (the release pins
  218,350; only the reviewed rules are accepted; configuration cannot set them).
- Tests: `packages/native/test/progressive-*.test.mjs`: lot pricing compared with the verifier's
  Python module, the reducer on synthetic receipts, and the settlement lifecycle compared with a
  separate test-only model and its Python twin. The reducer and `replay.py` are not yet compared on
  lot settlements.

```sh
pnpm typecheck && pnpm test
python3 packages/native/test/progressive-mint-witness.py -v
```
