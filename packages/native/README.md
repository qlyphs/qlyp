# @qlyphs/qlyp — QLYP-v1 protocol and transaction commands

QLYP-v1 defines fungible tokens, unique token symbols, Quarks (inscriptions), transfers and
bilateral token-for-QTC sales on Quantus. These are overlay balances interpreted from chain
transactions, not a native asset pallet. Runtime compatibility and network pins remain required.

## Encoding and identity

Canonical envelopes start with `QLYP` and version byte `1` (`0x514c595001`), then bind the
chain genesis, the signer's u64 protocol sequence and the operation. Amounts use u128 integers.
The complete payload is limited to 1,024 bytes. Version 0 payloads are not current operations.

An asset ID is `creator AccountId32 || sequence u64 little-endian`, scoped to its network.
Token symbols use `[A-Z0-9]{1,12}` and are unique: the first valid deployment in block order
claims the symbol. Quarks have no symbol; each has its own asset ID and sequential number.
A symbol is not a substitute for a full asset ID and network when signing a transaction.

## Required payments

QTC has 12 decimals. The package exports the exact fee constants, `fee(op, rate)` and
`saleFee(price)`.

| Operation | Qlyphs fee | Required call |
| --- | --- | --- |
| Deploy a token (plain or progressive) | 25 USD at the on-chain rate; 1 QTC under the legacy reading | Fee batch |
| Mint tokens | 0.01 QTC | Fee batch |
| Mint one lot of a progressive token | 0.1 to 0.5 QTC (v1) or 0.01 to 0.44 QTC (v2) by lot number | Its native settlement |
| Inscribe a Quark | 25 USD at the on-chain rate; 0.1 QTC under the legacy reading | Fee batch |
| Transfer tokens or a Quark | None | Direct `system.remark_with_event` |
| Buy a bilateral offer | 1% of the price, rounded up | Purchase batch |

The rate-derived fees follow the fee schedule
([docs/extension/PROTOCOL-FEES.md](../../docs/extension/PROTOCOL-FEES.md)): a rate posted on chain,
within fixed bounds and with public notice. Without a schedule, and below its activation, deploys
and inscriptions pay the fixed legacy fees. On Quantus mainnet the schedule and progressive-1000-v2
apply from block 218,350; progressive-1000-v1 never does.

A fee batch is exactly `utility.batch_all([system.remark_with_event(payload),
balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, exact_fee)])`, signed by the operation owner.
The matching successful receipt is also required. A bare deploy, mint or inscription is rejected.
Native failure rolls back the batch. A successful native payment does not guarantee QLYP
acceptance: for example, a losing symbol claim has no token effect but its fee is not refunded.
Network fees apply separately, including to failed transactions.

## Progressive tokens

Where the rules activate them, a progressive token (`deployProgressive`, tag 11) is minted in
exactly 1,000 equal lots of `cap / 1000`, one per mint, by anyone: lots 1–200 cost 0.1 QTC, then
0.2, 0.3, 0.4 and 0.5 QTC per 200 lots, 300 QTC in all. A `deployProgressiveV2` token (tag 12,
progressive-1000-v2) follows the same rules at 0.01, 0.10, 0.20, 0.30 and 0.44 QTC, 210 QTC in all. A lot is bought through a one-shot native
right, a 2-of-2 multisig that `multisig.create_multisig` creates only once:

```
utility.batch_all([
  multisig.create_multisig(ticket signers, 2, ticket nonce),
  balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, lot fee)
])
```

`progressiveLot(state, genesis, asset)` returns the next lot, its fee and this exact call. A payment
for a right already used fails on chain before any QTC moves, so a buyer who loses a race pays only
the network fee. Anything but the exact call mints nothing. The rules, activation and limits are in
[docs/native/PROGRESSIVE-MINT.md](../../docs/native/PROGRESSIVE-MINT.md).

## Sales and Quarks

A seller reserves a lot for one named buyer through an existing native seller/buyer 2-of-2
multisig proposal. It commits the asset, amount, payout, QTC price, required fee and expiry.
Once the reservation is finalized, its buyer signs exactly:

```
utility.batch_all([
  multisig.approve(multisig, proposal_id, exact_committed_call),
  balances.transfer_keep_alive(payout, price),
  balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, saleFee(price))
])
```

The first buyer approval is the one-use payment gate. There is no purchase-principal escrow or
`execute` in a purchase. QLYP credits tokens only when the canonical purchase succeeds with the
matching events. Cancellation or expiry releases a still-live reservation; cleanup never credits
an already settled lot again. This requires correct overlay interpretation and verified offer data.
It is not an anonymous-taker market, partial-fill order book, AMM or consensus-native token exchange.

Quarks use `inscribe` with a content type and bytes that fit the payload limit. They are 1-of-1
assets, transferable and sellable with amount `1`; they cannot be minted again. Identical content
may be inscribed more than once. Clients must render content as inert images or escaped text,
never as executable HTML or script.

## Public command surface

`parseCommand` validates `sendQtc`, `deploy`, `mint`, `transfer`, `pair`, `sell`, `buy`, `cancel`,
`inscribe`, `deployProgressive`, `deployProgressiveV2` and `mintProgressive`. `buildCall`, `preflight`, exact amount
utilities and fee helpers share the same rules; a progressive lot is built only from a
`ProgressiveLot` the caller verified. The reducer takes explicit `Rules`: by default
`mainnetRules()` on mainnet, the only rules accepted there, and `LEGACY_RULES` elsewhere.
Tags 11 and 12 stay unknown operations outside their activations in `{ progressive, progressiveV2 }`.
Invalid QLYP operations do not advance the protocol sequence; native transaction nonces are
separate. Tags 4–8 remain reserved for future operations and are rejected.

The replay engine checks block continuity, runtime, ordering and finality. Its activation pin is
an excluded checkpoint: the first interpreted block is `activation.height + 1` and must name
`activation.hash` as its parent. Replaying the same rules is reproducibility, not an independent
security audit or a proof that the configured node is honest.
