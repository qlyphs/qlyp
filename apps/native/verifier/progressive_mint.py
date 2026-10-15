"""Independent progressive mint rules (progressive-1000-v1 and -v2): integer pricing and the one-shot
mint right."""
import hashlib

PROFILE = 'progressive-1000-v1'
PROFILE_V2 = 'progressive-1000-v2'
LOT_COUNT = 1000
TOTAL_FEE = 300_000_000_000_000
TOTAL_FEE_V2 = 210_000_000_000_000
MAX_AMOUNT = 2**128 - 1
# Written from docs/native/PROGRESSIVE-MINT.md, not from the TypeScript implementation.
RIGHT_DOMAINS = {PROFILE: b'Qlyphs/ProgressiveMint/right/v1\0', PROFILE_V2: b'Qlyphs/ProgressiveMint/right/v2\0'}


def _need(condition, message):
    if not condition:
        raise ValueError(message)


def progressive_mint_quote(cap, minted, profile=PROFILE):
    """Calculate terms only; no reservation, authorization or payment guarantee."""
    _need(profile in (PROFILE, PROFILE_V2), 'unknown profile')
    # bool is an int subclass in Python but is never a valid protocol amount.
    _need(type(cap) is int and 0 < cap <= MAX_AMOUNT, 'invalid supply')
    _need(cap % LOT_COUNT == 0, 'supply must contain 1000 equal lots')
    _need(type(minted) is int and 0 <= minted <= cap, 'invalid minted amount')
    lot_size = cap // LOT_COUNT
    _need(minted % lot_size == 0, 'minted amount must contain whole lots')
    count = minted // lot_size

    # Written independently: do not load prices or calculated results from TypeScript.
    if count == LOT_COUNT:
        fee = None
    elif profile == PROFILE_V2:
        # 0.01, 0.10, 0.20, 0.30 and 0.44 QTC per 200-lot tier: 210 QTC in all.
        fee = (10_000_000_000, 100_000_000_000, 200_000_000_000, 300_000_000_000, 440_000_000_000)[count // 200]
    elif count < 200:
        fee = 100_000_000_000
    elif count < 400:
        fee = 200_000_000_000
    elif count < 600:
        fee = 300_000_000_000
    elif count < 800:
        fee = 400_000_000_000
    else:
        fee = 500_000_000_000

    return dict(profile=profile, lotSize=lot_size, mintedLots=count,
                remainingLots=LOT_COUNT-count, nextFee=fee)


def require_progressive_mint(cap, minted, amount, profile=PROFILE):
    """Validate one whole lot against supplied state, without reserving it."""
    quote = progressive_mint_quote(cap, minted, profile)
    _need(quote['nextFee'] is not None, 'mint sold out')
    _need(type(amount) is int and amount > 0, 'invalid mint amount')
    _need(amount == quote['lotSize'], 'mint amount must equal one lot')
    return dict(profile=profile, lot=quote['mintedLots']+1,
                amount=quote['lotSize'], fee=quote['nextFee'])


def mint_ticket(genesis, asset, minted_lots, anchor_hash, anchor_index, profile=PROFILE):
    """(signers, nonce) of the 2-of-2 multisig that is the right to mint the next lot.

    genesis (32 bytes), asset (40 bytes) and anchor_hash (32 bytes) are raw bytes. The pallet
    sorts signers bytewise and refuses duplicates."""
    _need(type(minted_lots) is int and 0 <= minted_lots < LOT_COUNT, 'no lot left to mint')
    _need(type(anchor_index) is int and 0 <= anchor_index <= 0xffffffff, 'invalid right anchor')
    _need(len(genesis) == 32 and len(asset) == 40 and len(anchor_hash) == 32, 'invalid right input')
    _need(profile in RIGHT_DOMAINS, 'unknown profile')
    name = hashlib.sha512(RIGHT_DOMAINS[profile] + genesis + asset + minted_lots.to_bytes(2, 'little')).digest()[:32]
    first, second = sorted((name, anchor_hash))
    _need(first != second, 'ticket signer collision')
    return (first, second), anchor_index
