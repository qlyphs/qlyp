# QLYP-v1 unique symbols and Quarks (inscriptions) — normative specification

Status: current QLYP-v1 rules, the same on every network. Token symbols are unique (first valid
claim wins); Quarks pay the INSCRIBE fee of the fee schedule (section 2), carry a content type and
bytes that fit one payload, and identical content may be inscribed again. Their sequential numbers
distinguish them. This describes the rules, not a deployed service. Extends [SPEC.md](SPEC.md); the
TypeScript reducer and the Python verifier MUST match exactly. Tags 4–8 stay reserved for future
operations and are rejected.

Naming: Qlyphs is the platform, QLYP the protocol. Each numbered item is a **Quark**, shown to
users as "Quark #n". A Quark is the equivalent of an NFT: unique, numbered content with a single
owner. On chain, a Quark is written as an *inscription*; this specification keeps that term (and
the `INSCRIBE` op and `inscription` policy) for the mechanism.

## 1. Unique symbols

State gains `symbols: Map<symbol, assetId>`. A DEPLOY whose symbol is already in
`symbols` is rejected (`rejected: symbol taken`), with no state effect and no sequence advance.
Its fee leg has already been paid to the fee account and is not refunded, so clients MUST check
availability right before signing and warn that a same-block claim can
still win. Symbols are already restricted to `[A-Z0-9]{1,12}`, so there is no case ambiguity.
Inscriptions have no symbol. Any future operation that claims a symbol shares this namespace; a
payload with a reserved tag claims none.

## 2. INSCRIBE (tag 9)

| Field | Encoding | Rule |
|---|---|---|
| contentType | `Vec<u8>` | ASCII, 3–64 bytes, matches `^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$` |
| content | `Vec<u8>` | 1 byte or more; the whole payload stays ≤ `MAX_PAYLOAD` (1024 bytes) |

Accepted call shape: the v1 fee batch `batch_all([remark_with_event(op),
transfer_keep_alive(QLYPHS_FEE_ACCOUNT, fee)])`, with the same event checks as DEPLOY/MINT. The fee
is rate-derived ([fee schedule](../extension/PROTOCOL-FEES.md)). Without a schedule and below its activation it is the
legacy `LEGACY_INSCRIBE_FEE = 100_000_000_000n` (0.1 QTC), also accepted during the schedule's grace
window; on mainnet the schedule applies from block 218,350. Any signer may inscribe; there is no privileged account.
The fee schedule sets a target of 25 USD per Quark, flat, converted at the on-chain rate (0.25 QTC at 100 USD per QTC), and
prices every DEPLOY at a flat 25 USD; only the six BLOCKED tickers (`BTC ETH QLYPHS QTC USDC USDT`)
cannot be deployed. Quark rarity is not fee-based.

Effect (accepted):
- `id = assetId(owner, sequence)` (40 bytes), `number = nextInscription` (starts at **1**,
  +1 per accepted inscription, never reused).
- `inscriptions.set(id, { id, number, creator: owner, contentType, content, height, index })`.
- It is also an Asset: `definition = { symbol: '', decimals: 0, cap: 1, limit: 0,
  policy: 'inscription' }`, `minted = 1`, balance `(id, owner) = 1`.
- Identical content is allowed; `sha256(content)` is exposed by read APIs for convenience only.

Ownership and trade reuse existing operations: TRANSFER with `amount = 1` moves it (no Qlyphs fee; network fees apply); OFFER
with `amount = 1` sells it (1 % sale fee). MINT on an inscription asset is rejected. Any
TRANSFER/OFFER amount other than 1 on an inscription asset is rejected.

## 3. Snapshot / attestation

The canonical snapshot includes `symbols`, `inscriptions` (sorted by number, content as hex) and
`nextInscription`. Both witnesses attest them.

## 4. Rendering rule for every client

Never interpret content as HTML or script. `image/png|jpeg|gif|webp` → `<img>` from a `data:` URL;
`image/svg+xml` → `<img>` from a `data:` URL only (never inline SVG); `text/*` and `application/json`
→ escaped text; anything else → a download link and a hex/size summary.
