# Progressive mint settlement: one-shot native rights

**Status: part of QLYP-v1 behind an explicit activation ([PROGRESSIVE-MINT.md](PROGRESSIVE-MINT.md)).
On Quantus mainnet, progressive-1000-v2 lots settle this way from block 218,350.**

Development runtime the settlement was first tested on: official Quantus v1.0.1 x86_64 development binary (archive SHA-256
`5880937c2a933b97d9916c5c9e78425d9918c6d7b68abe69de43680f62c13c93`), spec 152, transaction
version 6, runtime code hash `0xe2e37391ee730603d0c66dfbff9dafe9badc5dbc2caa7e151231e590c04ee820`,
a fresh local `--dev` chain. The multisig pallet source reviewed is
`pallets/multisig/src/lib.rs` blob `db8ea8cfc43bbe8ea619bc7d1bed1d24009f9852`.

## 1. Why a native right

At 199 minted lots two buyers can both read a 0.10 QTC price; once lot 200 is minted the next price
is 0.20 QTC. A payment that an overlay rejects after the chain accepted it would charge the loser.
A quote, API mutex, reservation table, `maxFee` field or witness signature cannot stop the runtime
from executing a payment. The runtime has to refuse the loser's payment itself.

`multisig.create_multisig(signers, threshold, nonce)` gives that refusal. The pallet derives the
multisig address from the sorted signers, threshold and nonce, refuses an address that exists
(`MultisigAlreadyExists`, checked before its fee is withdrawn), and has no call that removes a
multisig. So a given `(signers, 2, nonce)` can be created exactly once, ever. The runtime exposes
only `utility.batch_all` (no non-atomic `batch`, `force_batch` or `as_derivative`), and `batch_all`
reverts every call of the batch when one fails.

## 2. The right, its settlement and its rotation

One current right per progressive asset, public: no owner, queue, timer, deposit or reservation.

```
namespace = first_32_bytes(SHA512(
    ASCII("Qlyphs/ProgressiveMint/right/v1\0") || genesis[32] || assetId[40] || u16_le(minted lots)))
signers   = bytewise_sort([namespace, anchor.blockHash])      threshold = 2
nonce     = u64(anchor.extrinsicIndex)
```

The anchor is `{height, blockHash, extrinsicIndex}` of the progressive DEPLOY, then of the last use
of the previous right. Neither signer is a key. The namespace separates networks, assets and lots,
and it is distinct from any other Qlyphs ticket. The anchor's block hash exists only once that block
does, so nobody can create a future right in advance, and a right cannot be used in its own block.

The only settlement is the signer's own `utility.batch_all([multisig.create_multisig(signers, 2,
nonce), balances.transfer_keep_alive(QLYPHS_FEE_ACCOUNT, lot fee)])`, byte for byte, with exactly
one creation of the ticket by the signer, one payment of the lot fee to Qlyphs and one
batchCompleted in its receipt. It mints the lot to the signer. Any other creation of the ticket mints
nothing: bare, through `multisig.execute`, underpaid, reordered, with extra calls. Every use ends
the right and anchors the next one at its extrinsic, or none after lot 1,000.

## 3. Safety argument

For a right R that both pinned witnesses attest as current in the state at a best block X, signed
by the wallet with a mortal era born exactly at X:

1. If R is still unused when the signer's batch executes, its creation succeeds and the fee
   transfer follows. If the transfer fails, `batch_all` reverts the creation too and R stays usable.
   A successful batch is exactly the canonical settlement of R, so the lot is credited.
2. If R was used before, whether by a winning buyer or a burn, its multisig exists. The batch fails
   on its first call before the transfer runs, and the signer pays only the network fee.
3. Lot, amount and price are functions of R. A signature for lot 200 at 0.10 QTC names R(200). After
   lot 200 is minted the current right is R(201), and the 0.10 payment still names the consumed
   R(200). It can never be charged for lot 201, at either price. At lot 1,000 no right remains and
   every old payment names a consumed marker.
4. The settlement carries no QLYP payload or sequence. Another operation of the same account
   cannot make an accepted payment mint nothing.
5. R exists wherever the payment can execute. A signature commits to the block at its era's birth,
   here X itself (periods up to 4096 are not quantized), and is invalid on any chain without X. Any
   chain with X contains the history the witnesses attested, in which R is current at X; after X it
   is either still current (item 1) or used (item 2). A reorganization that drops X makes the
   payment invalid everywhere, so nothing is paid. X need not be final.

X is the best block of the wallet's node. If the witnesses cannot attest it yet, the wallet tries
once more a second later on the best block then, never on an older block: an older X would hand it
a used right whenever someone settles a right in every block.

X is also at most 256 blocks above the finalized checkpoint of the index that prepared the lot: the
index prepares nothing higher, and the wallet signs nothing it has not prepared. The lot is then
valid for at most 256 more blocks, and the activation guard fixes rules up to 512 blocks above the
checkpoint (section 4). A later checkpoint only moves that window up.

An era born before the right's anchor would not give item 5: a branch sharing that older block but
lacking the anchor would accept the payment, create the marker and take the fee with no right to
mint. The wallet never signs such an era.

Assumptions: the witnesses report the state at X honestly (the same trust as for any attestation),
the rules they apply stay fixed for the blocks a signed lot relies on (section 4), and the wallet
signs the exact bytes. Quantus finality is a depth rule, not a separate finality
gadget: each node finalizes the block `MaxReorgDepth` (100 on the pinned runtime) behind its best
block and never reorganizes below it; tip signing does not rely on it. A manually built payment for
a right that is not current, in another shape, or signed with an era older than the right, is
accepted by the runtime and may mint nothing. The wallet never builds one, and the reducer journals
it as rejected.

## 4. Limits

- **Throughput.** One lot per asset per block at best: a right cannot be used in the block that
  creates it. With wallets signing at the tip, a busy mint closes in about 1,000 blocks, some 3.3
  hours at Quantus's target of about 12 seconds per block. Parallel rights would need a separate
  design.
- **Cost of a lot.** Besides its Qlyphs fee, a lot burns the runtime's native ticket
  (`MultisigFee`) and pays a network fee. On the mainnet runtime (spec 153) that is 0.003 and about
  0.001 QTC: the first progressive-1000-v2 lot costs about 0.014 QTC in all. The development runtime
  (spec 152) charges ten times those native costs. Every lot and every burn leaves one permanent
  186-byte multisig marker on chain; the reducer keeps only one anchor per asset.
- **Fairness.** Anyone may settle a right as soon as it appears on the best chain, one lot per
  block. A wallet that signed only final rights could never mint while a bot did, since the final
  right would always have been used already; a wallet therefore signs at the tip, on its node's best
  block (section 3), and a lot goes to whoever lands first. Bots keep a latency advantage, not a
  structural one.
- **Griefing.** Anyone can burn the current right with a bare creation, for about 0.0039 QTC on the
  mainnet runtime. The next right is usable from the next block, so stalling an asset means winning
  every block's race with a burn: about 7,200 burns, some 28 QTC, a day at 12-second blocks.
  Rotation restores minting once an attack stops; it does not keep minting available during a
  sustained one. Buyers lose no Qlyphs fee: a payment for a burned right fails natively. Raising lot
  fees does not help, since a burn pays none. Burning a right only after a wallet has signed for it
  makes that payment fail natively and costs the buyer its network fee.
- **Manual calls.** A mispriced, reordered or wrapped payment, or one for a right that is not
  current, can pay Qlyphs without a lot. Only the exact call is protected.
- **Finality.** Wallets sign at the tip with an era born at the attested block (section 3, item 5), so
  a reorganization cannot make their payment execute without the right; it can only make it invalid.
- **Witness trust.** Attestations are operator claims by the pinned witnesses, not a consensus proof.
  The trust covers their software, chain data and signing infrastructure. Both are operated by
  Qlyphs: two engines guard against a fault in one of them, not against a compromise of both. Two
  keys that sign the same forged state are believed, and a wallet would then pay for a right that
  does not exist.
- **Fixed rules.** An activation cannot be set, moved or removed at or below the finalized
  checkpoint, nor within 512 blocks above it ([PROGRESSIVE-MINT.md](PROGRESSIVE-MINT.md)): a signed
  lot may rely on those blocks, and other rules could drop the token it paid for. On mainnet the
  activation is fixed in the protocol itself (`MAINNET_PROGRESSIVE_V2_FROM`,
  [PROGRESSIVE-MINT.md](PROGRESSIVE-MINT.md) section 5), never by configuration.
- **Runtime upgrades.** A payment signature commits to the runtime's spec version, so a payment
  signed before an upgrade cannot run after it. The index and both witnesses are pinned to one
  runtime and stop at the first block another one ran: they never read blocks they were not checked
  against.
- **Witness load.** A tip attestation replays the blocks above the witness's finalized state. The
  witnesses bound the blocks, time, memory and requests a tip may use; a request beyond those
  bounds is refused, and nothing is signed for it.
