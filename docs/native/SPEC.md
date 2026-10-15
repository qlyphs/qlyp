# Qlyphs native QLYP-v1: asset rules, fees and bilateral payment gate

Status: current protocol rules. Protocol version byte is 1 (`QLYP-v1`). Version 0 payloads are
not QLYP operations; they are ignored like foreign remarks. On Quantus mainnet the fee schedule and
progressive-1000-v2 apply from block 218,350 (`MAINNET_FEE_SCHEDULE` and
`MAINNET_PROGRESSIVE_V2_FROM` in `packages/native/src/protocol.ts`); progressive-1000-v1 never does.
Every other rule, purchases included, is the same on every network. This spec does not attest to a
deployed service.

## QLYP v1: fees

Qlyphs fee account, a protocol constant identical on every network:
`0x2139a57532fbf4764ad95754c17545fed7af915fb008b6494b02e503084da8b3`
(SS58 `qzkCoLhkccQnzEG79s61bFpf5bLKfKKnq7S5YqazgzdCwgARA`). QTC has 12 decimals.

Fee schedule (fees-1; on mainnet from block 218,350): the [fee schedule spec](../extension/PROTOCOL-FEES.md)
is normative for the DEPLOY and INSCRIBE fees and replaces the fixed amounts below with USD targets (DEPLOY a flat 25 USD for every allowed symbol, 0.25 QTC at 100 USD
per QTC; INSCRIBE 25 USD; six BLOCKED tickers, `BTC ETH QLYPHS QTC USDC USDT`, cannot be deployed), converted by an on-chain
rate that Qlyphs signs and publishes with a public delay (tags 13 and 14). These are the
rate-derived fees. Their former fixed constants are legacy fees: on every network, mainnet
included, they price operations without a schedule, before its activation and during the grace
window after it, so earlier blocks keep their legacy reading and fees-1 changes how no mainnet block
below its activation is read (fee schedule spec, section 5.5). The genesis grid, whose rate
is fixed in the activation rules, prices every rate-derived operation until a new grid takes
effect, and stays in force if none ever does. MINT keeps its fixed 0.01 QTC fee and exact-fee rule
at every height and needs no rate. The sale fee, OFFER, TRANSFER, progressive lot fees and the fee
batch shape are unchanged.

| Operation | Qlyphs fee | Required call shape |
|---|---|---|
| DEPLOY (create token) | 25 USD target at the on-chain rate ([fee schedule](../extension/PROTOCOL-FEES.md)); legacy `LEGACY_DEPLOY_FEE` 1 QTC = `1_000_000_000_000` | fee batch (below) |
| MINT | 0.01 QTC = `10_000_000_000`, fixed at every height | fee batch (below) |
| INSCRIBE (create Quark) | 25 USD target at the on-chain rate ([fee schedule](../extension/PROTOCOL-FEES.md)); legacy `LEGACY_INSCRIBE_FEE` 0.1 QTC = `100_000_000_000` | fee batch (below) |
| PROGRESSIVE DEPLOY (V2) | as DEPLOY | fee batch (below); only from its profile's activation (section 6) |
| PROGRESSIVE MINT (one lot) | by lot number: 0.1 to 0.5 QTC, 300 QTC for all 1,000 lots (v1); 0.01 to 0.44 QTC, 210 QTC in all (v2) | its native settlement (section 6), not a QLYP payload |
| TRANSFER (token) | none | direct signed `system.remark_with_event(payload)` |
| OFFER / sale | `saleFee(price)`, paid by the buyer | direct multisig proposal; purchase batch in section 4 |

Fee batch for DEPLOY, MINT and INSCRIBE, signed by the operation owner:

```
utility.batch_all([
  system.remark_with_event(payload),
  balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, exact_fee)
])
```

Exactly these two calls, in this order, with byte-exact encoding. The extrinsic must succeed, and
its receipt must show exactly one `remarked` by the signer, exactly one `paid` from the signer to
the fee account of exactly the fee (for a rate-derived fee, one of the amounts the fee schedule spec,
section 5.3, accepts), and exactly one `batchCompleted`. Otherwise the operation is
rejected (`rejected: ...` verdict) with no state effect and no sequence advance. That covers a bare
`remark_with_event` (the v0 shape), a wrong amount or recipient, extra or reordered calls, and a
failed payment. A v1 remark found inside any batch is checked against these rules, so a misshapen
batch is rejected rather than silently ignored. A TRANSFER wrapped in a batch is rejected.

`batch_all` is atomic: when the fee leg cannot be paid (for example the signer lacks the funds),
the whole extrinsic fails and its remark is reverted with it. The indexer still records a signed
failed extrinsic that declares a decodable DEPLOY, MINT or INSCRIBE payload as `rejected: fee batch failed`
(`rejected: extrinsic failed` when the call was not a batch), with no state effect and no sequence
advance; the signer still pays the network fee. Other failed extrinsics, including a failed
TRANSFER, OFFER or purchase, get no QLYP verdict. Wallets check the signer's spendable balance
against the Qlyphs fee, network fees and the existential deposit before signing.

Sale fee, a general rule: any token-for-QTC exchange pays 1% of the QTC price to Qlyphs, rounded up:

```
saleFee(price) = ceil(price * 100 / 10000) = (price * 100 + 9999) / 10000   // integer division
```

With `price > 0`, the fee is at least 1 base unit (for example, 1 -> 1, 100 -> 1, 101 -> 2, 10000 -> 100).
An OFFER must commit `fee == saleFee(price)` and `fee recipient == QLYPHS_FEE_ACCOUNT` (and the
buyer cannot be the fee account). Otherwise the offer is rejected. In the purchase batch, the buyer
pays the seller the full price and pays the fee to Qlyphs, so the seller's payout is unchanged. Today
the only exchange is OFFER (tag 3). A future open-offer or DEX operation inherits the same 1% rule.
Tags 4–8 are reserved for future operations; tag 9 is INSCRIBE
([INSCRIPTIONS.md](INSCRIPTIONS.md)).

Why transfers are free: a token transfer moves value between holders without creating supply or
exchanging it for QTC, and a fee there would tax ordinary custody moves such as consolidation or
gifts. Fees apply where Qlyphs provides the service: issuance (deploy, mint) and exchange (sale).
Plain QTC sends (`sendQtc`) are native transfers, not QLYP operations, and carry no Qlyphs fee.

Implementation: `packages/native/src/protocol.ts` (`QLYPHS_FEE_ACCOUNT`, `MINT_FEE`, `SALE_FEE_BPS`,
`saleFee`, `feeBatchCall`) and `packages/native/src/fee-schedule.ts` (`fee`, `LEGACY_DEPLOY_FEE`,
`LEGACY_INSCRIBE_FEE`, the fee state and tags 13 and 14), mirrored by `apps/native/verifier/replay.py`.

## 1. Sources and interpretation

Pinned development target: Quantus `v1.0.1`, runtime spec 152, transaction version 6. Quantus
mainnet runs runtime spec 153, transaction version 6, with the same calls and events; a mainnet
reader is pinned to the runtime it was checked against.
Where a source comment and its implementation differ, QLYP relies on the implementation.

- https://github.com/Quantus-Network/chain/blob/v1.0.1/pallets/frame-system/src/lib.rs
  `remark_with_event` authenticates origin and emits sender/hash; bytes remain in the extrinsic.
- https://github.com/Quantus-Network/chain/blob/v1.0.1/pallets/utility/src/lib.rs
  `batch_all` dispatches from one origin and rolls back when a child returns an error.
- https://github.com/Quantus-Network/chain/blob/v1.0.1/pallets/multisig/src/lib.rs
  `propose` stores canonical bytes and gives proposer first approval; `approve` checks exact bytes,
  membership, expiry and AlreadyApproved; `cancel` removes Active or Approved proposals.
  `execute` requires a signer and returns outer success even on inner failure; do not use it as
  a payment guard. Removing a proposal does not automatically refund an escrow's principal.
- https://github.com/Quantus-Network/chain/blob/v1.0.1/runtime/src/lib.rs
  Assets and contracts are absent from this runtime; scheduler extrinsics are disabled.
- https://github.com/Quantus-Network/chain/blob/v1.0.1/runtime/src/configs/mod.rs
  QTC unit is 10^12; existential deposit is 10^9 base units. Confirmation depth and economic
  constants must be read from the actual runtime, not assumed from a UI or SDK method name.
- https://docs.quantus.com/deep-dives/qpow/
  PoW client finalization depth is 100 blocks. Mainnet readers count a block as final 20 blocks below the best one
  (`MAINNET_FINALITY_DEPTH` in `packages/native/src/network.ts`) and stop rather than follow a
  deeper reorganization.
- https://github.com/Quantus-Network/quantus-wasm/blob/main/README.md
  Official ML-DSA signing. The dependency lockfile, not a moving README, selects the binary.
  Existing chain code signs legacy ML-DSA-87; no switch of wallet scheme is included here.

A source review, a release binary, deployed mainnet code and an executed test are distinct evidence.

## 2. Encoding

The authoritative byte grammar is `packages/native/src/codec.ts`. No JSON is signed.
Header: ASCII QLYP (4 bytes), version=1 (u8), genesis (32 bytes), sequence (u64 little-endian),
operation enum tag (u8). Fixed integers follow SCALE encoding; variable byte vectors use canonical
SCALE compact lengths. Full consumption and byte-for-byte re-encoding are mandatory.

Operation tags/fields, in order:

| Tag | Operation | Fields |
|---|---|---|
| 0 | DEPLOY | symbol Vec<u8>, decimals u8, cap u128, mint limit u128, policy u8 (0 open / 1 issuer) |
| 1 | MINT | asset id [u8;40], amount u128 |
| 2 | TRANSFER | asset id [u8;40], amount u128, recipient AccountId32 |
| 3 | OFFER | asset id [u8;40], amount u128, buyer AccountId32, QTC payout AccountId32, price u128, fee u128, fee recipient AccountId32, expiry u32 |
| 4–8 | RESERVED | Reserved for future operations. Rejected as `reserved operation`; never interpreted. |
| 9 | INSCRIBE | content type Vec<u8> (ASCII 3–64 bytes), content Vec<u8> (≥1 byte); see [INSCRIPTIONS.md](INSCRIPTIONS.md) |
| 10 | — | Reserved for a future operation: rejected as `unknown operation` |
| 11 | PROGRESSIVE DEPLOY | symbol Vec<u8>, decimals u8, cap u128 (a multiple of 1000); read only from the progressive activation, an unknown operation before it (section 6) |
| 12 | PROGRESSIVE DEPLOY V2 | the same fields as tag 11, on the progressive-1000-v2 profile; read only from its own activation (section 6) |
| 13 | FEE_RATE | effective u32, rate u64; read only from `feeSchedule.from`, an unknown operation before ([fee schedule](../extension/PROTOCOL-FEES.md) section 7) |
| 14 | FEE_ADMIN | action u8 and its body; read only from `feeSchedule.from`, an unknown operation before ([fee schedule](../extension/PROTOCOL-FEES.md) section 8) |
| 15 | RESERVED | NAME_COMMIT, not part of fees-1; rejected as `reserved operation` ([fee schedule](../extension/PROTOCOL-FEES.md) section 11) |
| 16+ | — | Unknown operation, rejected |

Payload <=1024 bytes. Positive amounts/cap/limit, cap >= limit, symbol [A-Z0-9]{1,12}, decimals 0..18.
No floats or implicit partial mints. A mint may request any positive amount up to the per-mint
limit and remaining cap; the limit is not a mandatory fixed mint amount. Token symbols are unique
within the network: the first valid DEPLOY in block/extrinsic order claims the symbol. A losing
claim does not advance the sequence, but a successful native fee payment is not refunded.
Quarks do not claim symbols; see [INSCRIPTIONS.md](INSCRIPTIONS.md). An offer fee must equal `saleFee(price)` (see QLYP v1: fees). Asset ID = creator's
32-byte ID followed by the deploy sequence's 8-byte LE encoding, scoped to this genesis/version.
Sequence starts at 0 for each authenticated account; only a valid token operation advances it.
The maximum sequence is rejected rather than wrapping. Native extrinsic nonce is separate.

## 3. State and replay

`available[asset,owner]`, `reserved[ticket]`, immutable asset definition and minted supply.
Invariant: sum(available) + sum(live reservations) == minted <= cap. Transfers cannot spend reservations.

Only the successful signed fee batch can deploy, mint or inscribe; only a direct successful signed
`remark_with_event` can transfer (see QLYP v1: fees). An offer requires a direct
successful propose of `system.remark(offer)` with exact seller/buyer 2-of-2 membership, immutable terms,
matching native expiry, and sufficient available tokens AT CREATION. Invalid proposals never become
valid retroactively. A ticket is `(genesis, multisig AccountId32, native proposal_id)`.

Replay all transactions in block/extrinsic order; bind events to their actual phase/index. Read raw
extrinsics as well as events. Unknown calls are not token operations, but all persisted multisig
lifecycle events remain observable, including wrapped calls. Never infer a successful inner call
from outer ExtrinsicSuccess. Failed/unexecuted raw bytes have no token effects.

Block parent, height, runtime, ordering and finality are checked before committing a detached snapshot.
Provisional reorg requires rollback to a known hash/height followed by replay. A rollback below finalized
state is refused. Unsupported runtime stops processing rather than silently changing interpretation.
The activation pin is an excluded finalized checkpoint with initially empty QLYP state. The first
interpreted block is `activation.height + 1` and must have `activation.hash` as its parent; the
anchor and all earlier operations are excluded. A deployment must publish the exact genesis,
anchor and rules. Changing an established anchor changes protocol history. Indexer inputs are trusted-node receipts, not
user-supplied proof objects. Replaying the same implementation twice is reproducibility, not an
independent audit or independent second implementation.

## 4. Purchase and cancellation

Seller creates a native proposal for buyer B; its valid offer locks tokens in the overlay. Buyer verifies
this reservation in finalized state and signs only the canonical call:

```
utility.batch_all([
  multisig.approve(M, proposal_id, exact_committed_call),
  balances.transfer_keep_alive(payout, price),
  // v1: fee = saleFee(price) >= 1, so this leg is always present
  balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, fee)
])
```

All children use buyer's origin. Fees, price, payout, buyer, asset and quantity are already committed.
No purchase principal is deposited in M. Successful exact batch + matching persisted approval/payment
records settles reserved tokens to B. Delivery is a deterministic protocol transition, not a server
callback. Replaying the purchase with a fresh native nonce fails AlreadyApproved (or missing proposal).

A native payment/fee-leg failure must roll back the approval and payment events/storage. This is the
main E2E assertion. Transaction fees can still be charged. Cancel-before-buy makes approve fail, so no
price is paid. Buy-before-cancel delivers tokens; later cleanup cannot release them again.

First buyer approval outside the canonical successful purchase invalidates the reservation and releases
it without delivery. There can be no future successful first approval on that ticket. Cancel/remove/
execute removal likewise releases only still-live reservations. Expiry is inclusive: unlock at height
strictly GREATER than expiry, exactly when native approve starts refusing the ticket.

This guarantee is conditional on a valid finalized ticket, a conforming buyer client, correct ingestion
and the agreed overlay rules. The runtime does NOT know token balances. An arbitrary manually crafted
QTC payment, an invalid offer, altered client bytes or a dishonest indexer are not protected by this
specification. Do not claim consensus-native atomic token exchange.

## 5. Verification and exclusions

The unit tests cover codec boundaries, malformed payloads, supply, authorization, sequence/domain
replay, reservation ownership, cancellation/cleanup, expiration boundary, provisional rollback,
runtime drift and atomic checkpoint errors.

These tests do not establish mainnet witness compatibility, actual deep PoW reorg behavior,
adversarial multi-node consensus/finality, high-load availability or an independent security
audit.

## 6. Progressive mint (progressive-1000-v1 and -v2)

A PROGRESSIVE DEPLOY (tag 11) creates a token that is minted in exactly 1,000 equal lots of
`cap / 1000` base units, one lot per mint, by anyone, at a Qlyphs fee fixed by the lot number:
0.1 QTC for lots 1–200, 0.2 for 201–400, 0.3 for 401–600, 0.4 for 601–800 and 0.5 for 801–1000.
There is no limit, policy, curve or lot count to choose, no creator share and no pre-mint. It
shares the symbol namespace with DEPLOY and pays the DEPLOY fee ([fee schedule](../extension/PROTOCOL-FEES.md)) in the same fee batch. Tag 11
always means this profile: its lot count, fees and right derivation are frozen, pinned by tests and
hashed into the witnesses' rules fingerprint. Another profile needs a new tag and activation, so
that existing tokens keep their terms. PROGRESSIVE DEPLOY V2 (tag 12) is such a profile,
progressive-1000-v2: the same lots and rules at 0.01, 0.10, 0.20, 0.30 and 0.44 QTC per 200 lots
(210 QTC in all), with its rights named in their own domain (`right/v2`). A MINT
(tag 1) of a progressive asset is rejected, and no legacy asset can be minted progressively.

A lot is bought through a one-shot native right: the 2-of-2 multisig named by
`signers = sort([namespace, anchor.hash])`, threshold 2, nonce `anchor.index`, where
`namespace = SHA-512("Qlyphs/ProgressiveMint/right/v1\0" || genesis || asset || u16_le(minted lots))[0..32]`
and the anchor is the block hash and extrinsic index of the DEPLOY or of the last use of the
previous right. The only settlement is the signer's own
`utility.batch_all([multisig.create_multisig(signers, 2, nonce), balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, lot fee)])`,
byte for byte, with exactly one creation by the signer, one payment of the lot fee to Qlyphs and one
batchCompleted in its receipt. It mints the lot to the signer. Any other creation of the ticket
(bare, wrapped, underpaid, reordered) mints nothing. Either way the right ends: the next one is
anchored at that extrinsic, or none once all lots are minted. A right cannot be used in the block
that creates it, and the Qlyphs fee account cannot mint.

Because the runtime refuses a second creation of the same multisig before charging anything, and
batch_all reverts the creation when the payment fails, a payment signed for a right that is no longer
current fails on chain before any QTC moves: a buyer who loses a race, including at a fee tier
boundary or the last lot, pays the network fee only. Progressive mint uses no QLYP payload or
sequence, so another operation of the same account cannot invalidate it. The reducer keeps only the
current anchor per asset; tier, fee, lot number and progress are derived from `minted`. A ticket is
not recorded as an ordinary multisig. A settlement-shaped payment that uses no current right is
journaled as rejected, and so is a failed one, with its reason.

Activation is explicit. On a development network the rules name the first block where tag 11
counts and the first where tag 12 counts, and both are bound into the witnesses' rules fingerprint. On
mainnet the activation is a constant of the code: tag 12 counts from block 218,350
(`MAINNET_PROGRESSIVE_V2_FROM`), tag 11 never, and a configured height is refused. Earlier blocks
keep their legacy reading. A durable index refuses an activation at or below its finalized
checkpoint, and removing it after that point. Wallets sign a lot at the tip, from
both witnesses' tip attestation of a recent best block, with an era born exactly at that block, so
the payment can only execute on chains that contain the attested state, where the right is current
or already used. Details
and limits: [PROGRESSIVE-MINT.md](PROGRESSIVE-MINT.md) and
[PROGRESSIVE-MINT-SETTLEMENT.md](PROGRESSIVE-MINT-SETTLEMENT.md).

## 7. Scope and release gates

The current exchange is a restricted bilateral ticket for a named buyer. An anonymous-taker
order book, AMM or consensus-enforced asset exchange is not implemented. No automatic bridge,
asset migration, balance administrator or mutable issuance rule is part of QLYP-v1.

Before enabling additional live operations, require a reviewed public spec and fixed activation,
independent protocol and implementation review, durable replay/reorg/restart validation,
wallet clearsigning, runtime fingerprint verification, load limits, witness divergence monitoring,
measured fees and appropriate user-facing risk explanations.
