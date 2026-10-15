<div align="center">

# QLYP

**The Qlyphs protocol: tokens, unique symbols and Quarks on [Quantus](https://quantus.com).**
Every rule that decides a balance is in this repository, written twice: in TypeScript and in Python.

[Spec](docs/native/SPEC.md) · [Fees](docs/extension/PROTOCOL-FEES.md) · [Progressive mint](docs/native/PROGRESSIVE-MINT.md) · [Quarks](docs/native/INSCRIPTIONS.md) · [Security](SECURITY.md)

![license MIT](https://img.shields.io/badge/license-MIT-blue) ![Node 24](https://img.shields.io/badge/node-24-339933) ![Python 3](https://img.shields.io/badge/python-3-3776ab)

</div>

---

## What QLYP is

Quantus has no smart contracts. QLYP is an overlay protocol: each operation is a `QLYP`-prefixed
payload in a native `system.remark_with_event`, usually inside a `utility.batch_all` that also pays
the protocol fee. Reading finalized blocks in order and applying these rules gives every balance.
Balances follow only from these rules and the chain. One input comes from Qlyphs: the fee rate that
prices deploys and inscriptions, which a Qlyphs key publishes on chain within fixed bounds and with
public notice (see the [trust model](docs/extension/PROTOCOL-FEES.md#9-trust-model)).

It defines:

- **Tokens** with unique symbols, minted by their creator or, for progressive tokens, in 1,000
  equal lots that anyone can buy at fixed tiered prices.
- **Quarks**, numbered 1-of-1 inscriptions of up to 1 KB.
- **Transfers**, free, and **bilateral sales** reserved for one named buyer.
- **A fee schedule** priced in USD through an on-chain rate with public notice, bounded steps and
  a separate key that can freeze it.

On Quantus mainnet, progressive mint (progressive-1000-v2) and the fee schedule apply from block
218,350. That height is a constant of the code.

## Two implementations

| | Language | Where |
| --- | --- | --- |
| **Reference reducer** | TypeScript, no runtime dependencies | [`packages/native`](packages/native/README.md) |
| **Independent verifier** | Python, standard library only | [`apps/native/verifier`](apps/native/verifier) |

The verifier is a separate port of the rules, not a translation of the reducer's output. The cross
tests feed both the same blocks and require the same state root: at every block of seeded random
histories, and at the recorded heights of the published
[vectors](docs/native/vectors/fee-schedule.json). They cover the fee-bearing operations (DEPLOY,
MINT, INSCRIBE and the progressive deploys), blocked symbols, the legacy fee reading and fee
schedule governance (FEE_RATE, FEE_ADMIN and resets). Verdicts are compared directly only in the unit
tests of the u32 bounds (a FEE_RATE at the last grid id and the limits of the fee rules). Progressive lot pricing is compared with the verifier's Python
module, and the lot settlement lifecycle with a separate test model and its Python twin.
Transfers, offers, purchases and lot settlement are implemented in both engines but not yet
cross-tested.

## Run the tests

Node 24, pnpm 10 and Python 3:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

`pnpm test` runs the protocol suite (fee and inscription attacks, fee schedule properties,
progressive mint settlement, and a mainnet cutover regression on a fixture of synthetic blocks),
then the cross tests between the reducer and the verifier.

## Limits

- The rules are only as final as the blocks they read: QLYP trusts a Quantus node for consensus and
  signature checks, and reads only blocks below its finality depth.
- Replaying mainnet end to end also needs QLYP's activation anchor on mainnet, the runtime pins and
  a decoder of the chain's metadata. They are not in this repository yet.
- Fees and progressive lot prices are enforced by the rules. What happens off chain, such as the
  rate publisher or any account that trades with users, is operated, not enforced. The trust model
  of each key is in the [fee schedule spec, section 9](docs/extension/PROTOCOL-FEES.md#9-trust-model).
- Some code comments predate the mainnet activation; the specs in `docs/` are normative.
- No independent audit has been commissioned.

## License

[MIT](LICENSE). Report a vulnerability privately: see [SECURITY.md](SECURITY.md).
