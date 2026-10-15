#!/usr/bin/env python3
"""Independent QLYP-v1 reducer and byte decoder (standard library only).

Production-mode input identifies blocks to read from this witness's own RPC via
rpc.py. Unit-test mode accepts normalized receipts. Neither mode reads the primary
indexer's API/database. This is not an independent consensus client.
Never receives a signing key. On restart the parent replays its own durable journal.
"""
import copy
import json
import re
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from progressive_mint import PROFILE, PROFILE_V2, mint_ticket, progressive_mint_quote
from fee_schedule import (FEE_ACCOUNT, MINT_FEE, ZERO, allowed_fees, apply_fee_admin, apply_fee_rate, fee_invariants,
                          is_rate_derived, legacy_fee, need, parse_fee_rules, snapshot_fees, step_fees)
from tickers import BLOCKED, TICKERS_DIGEST

MAINNET = '0xfb5487c0be6ae4ade2d41d16e50465129861636c2b8d61fa94d7a19631626fba'
# The reviewed mainnet activation of progressive-1000-v2, or None while there is none. It mirrors
# MAINNET_PROGRESSIVE_V2_FROM in packages/native/src/protocol.ts; until it is set this verifier
# refuses mainnet altogether, and no configuration can change that.
MAINNET_PROGRESSIVE_V2_FROM = 218350
# The reviewed mainnet fee schedule, or None while there is none. It mirrors MAINNET_FEE_SCHEDULE in
# packages/native/src/protocol.ts and is set with the same `from` as MAINNET_PROGRESSIVE_V2_FROM and
# legacyBefore true: the legacy fees stay readable below `from` and for `grace` blocks after it.
MAINNET_FEE_SCHEDULE = {
    'from': 218350,
    'operator': '0x1581d983b4e5ea7cdc09e367934cb3ee26668a9812e93c0fb11c233108dae379',
    'guardian': '0x58cefd2c30b74c033a3cbb09dbb956aecc55c236df5d5a8d0fdb7be0ec7f41f8',
    'sentinel': '0xadadf0774413e40aa14f9b8474cfbb84e59c369cb5aaeb49cc328422b7560feb',
    'rate': '12200000000',
    'delay': 7200,
    'grace': 4608,
    'guardianDelay': 50400,
    'legacyBefore': True,
    'resets': [],
}
MAX = 2**128 - 1
MAX_LINE = 16 * 1024 * 1024
# QLYP-v1: ASCII "QLYP" + version byte 1. Any other header (v0 included) is a foreign remark.
HEADER = b'QLYP\x01'
HEADER_HEX = '0x' + HEADER.hex()
# Qlyphs fees: MINT and the rate-derived DEPLOY and INSCRIBE fees live in fee_schedule.py.
SALE_FEE_BPS = 100               # 1% of any token-for-QTC exchange
# Unique symbols and Quarks (inscriptions) (docs/native/INSCRIPTIONS.md), written independently.
CONTENT_TYPE = re.compile(r'[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*')
FIRST_INSCRIPTION = 1
# Every runtime batch the protocol reads has at most 3 calls.
MAX_BATCH_CALLS = 3
# Tags 4..8 are RESERVED for the planned launchpad/AMM (docs/native/LAUNCHPAD-AMM.md: planned, not
# part of the protocol), and tag 15 for a later name commit. A payload carrying one of them is
# rejected, never interpreted.
RESERVED_TAGS = (4, 5, 6, 7, 8, 15)
# PROGRESSIVE DEPLOY (tag 11) and V2 (tag 12), docs/native/PROGRESSIVE-MINT.md, each read only from
# its configured activation.
PROGRESSIVE_DEPLOY = 11
PROGRESSIVE_DEPLOY_V2 = 12
# FEE_RATE (tag 13) and FEE_ADMIN (tag 14), read only from the fee schedule's first block.
FEE_RATE = 13
FEE_ADMIN = 14
FEE_ADMIN_ACTIONS = ('cancel', 'freeze', 'setOperator', 'setGuardian', 'setSentinel')
# The profile of each progressive policy.
PROFILES = {'progressive': PROFILE, 'progressive-v2': PROFILE_V2}


def sale_fee(price):
    # ceil(price * 1% ); integer arithmetic only
    need(type(price) is int and price >= 0, 'price')
    return (price * SALE_FEE_BPS + 9999) // 10000


def hx(b):
    return '0x' + b.hex()


def unhex(s, length=None):
    need(isinstance(s, str) and re.fullmatch(r'0x(?:[0-9a-f]{2})*', s), 'hex')
    b = bytes.fromhex(s[2:])
    need(length is None or len(b) == length, 'hex length')
    return b


def compact(n):
    need(type(n) is int and 0 <= n <= MAX)
    if n < 64:
        return bytes([n << 2])
    if n < 16384:
        return ((n << 2) | 1).to_bytes(2, 'little')
    if n < 2**30:
        return ((n << 2) | 2).to_bytes(4, 'little')
    size = (n.bit_length() + 7) // 8
    return bytes([((size - 4) << 2) | 3]) + n.to_bytes(size, 'little')


class Reader:
    def __init__(self, raw):
        self.raw, self.at = raw, 0

    def read(self, n):
        need(type(n) is int and 0 <= n and self.at + n <= len(self.raw), 'truncated')
        out = self.raw[self.at:self.at+n]
        self.at += n
        return out

    def num(self, n):
        return int.from_bytes(self.read(n), 'little')

    def ident(self, n=32):
        return hx(self.read(n))

    def comp(self):
        start = self.at
        tag = self.num(1)
        mode = tag & 3
        if mode == 0:
            value = tag >> 2
        elif mode in (1, 2):
            value = (tag | (self.num(1 if mode == 1 else 3) << 8)) >> 2
        else:
            size = (tag >> 2) + 4
            need(size <= 16, 'compact size')
            value = self.num(size)
        need(self.raw[start:self.at] == compact(value), 'noncanonical compact')
        return value

    def vector(self, limit=1024):
        size = self.comp()
        need(size <= limit, 'vector size')
        return self.read(size)

    def end(self):
        need(self.at == len(self.raw), 'trailing input')


def operation(raw, progressive=False, progressive_v2=False, fee_schedule=False):
    need(len(raw) <= 1024, 'payload size')
    r = Reader(raw)
    need(r.read(5) == HEADER, 'protocol version')
    genesis, sequence, tag = r.ident(), r.num(8), r.num(1)
    if (tag == PROGRESSIVE_DEPLOY and progressive) or (tag == PROGRESSIVE_DEPLOY_V2 and progressive_v2):
        symbol = r.vector(12).decode('ascii')
        decimals, cap = r.num(1), r.num(16)
        need(re.fullmatch(r'[A-Z0-9]{1,12}', symbol) and decimals <= 18 and cap > 0, 'progressive deploy')
        p = dict(kind='deployProgressive' if tag == PROGRESSIVE_DEPLOY else 'deployProgressiveV2',
                 symbol=symbol, decimals=decimals, cap=cap)
    elif tag == FEE_RATE and fee_schedule:
        p = dict(kind='feeRate', effective=r.num(4), rate=r.num(8))
    elif tag == FEE_ADMIN and fee_schedule:
        action = r.num(1)
        need(action < len(FEE_ADMIN_ACTIONS), 'unknown fee admin action')
        p = dict(kind='feeAdmin', action=FEE_ADMIN_ACTIONS[action])
        if action in (2, 3, 4):
            p['account'] = r.ident()
        if action in (2, 3):
            p['effective'] = r.num(4)
    elif tag == 0:
        symbol = r.vector(12).decode('ascii')
        decimals, cap, limit, policy = r.num(1), r.num(16), r.num(16), r.num(1)
        need(re.fullmatch(r'[A-Z0-9]{1,12}', symbol) and decimals <= 18)
        need(0 < limit <= cap and policy in (0, 1))
        p = dict(kind='deploy', symbol=symbol, decimals=decimals, cap=cap,
                 limit=limit, policy='open' if policy == 0 else 'issuer')
    elif tag == 9:
        content_type = r.vector(64).decode('ascii')
        need(3 <= len(content_type) <= 64 and CONTENT_TYPE.fullmatch(content_type), 'content type')
        content = r.vector()
        need(len(content) >= 1, 'empty content')
        p = dict(kind='inscribe', contentType=content_type, content=hx(content))
    else:
        need(tag not in RESERVED_TAGS, 'reserved operation')
        need(tag in (1, 2, 3), 'operation tag')
        asset, amount = r.ident(40), r.num(16)
        need(amount > 0, 'positive amount')
        p = dict(kind=['', 'mint', 'transfer', 'offer'][tag], asset=asset, amount=amount)
        if tag == 2:
            p['to'] = r.ident()
        if tag == 3:
            p.update(buyer=r.ident(), payout=r.ident(), price=r.num(16), fee=r.num(16),
                     feeTo=r.ident(), expiry=r.num(4))
            need(p['price'] > 0 and p['price'] + p['fee'] <= MAX)
            need(p['fee'] != 0 or p['feeTo'] == ZERO, 'zero fee recipient')
    r.end()
    return genesis, sequence, p


def call(raw, depth=0):
    need(depth <= 3 and len(raw) <= 4096, 'call depth/size')
    r = Reader(raw)

    def one(in_batch=False):
        pallet, tag = r.num(1), r.num(1)
        if pallet == 0 and tag in (0, 7):
            return dict(kind='remark', event=tag == 7, payload=hx(r.vector()))
        if pallet == 2 and tag == 3:
            need(r.num(1) == 0, 'address type')
            return dict(kind='pay', to=r.ident(), amount=r.comp())
        if pallet == 19 and tag in (1, 2):
            multisig = r.ident()
            proposal = r.num(4) if tag == 2 else None
            child_raw = r.vector(2048)
            child = call(child_raw, depth + 1)
            if tag == 1:
                return dict(kind='propose', multisig=multisig, call=child,
                            childHex=hx(child_raw), expiry=r.num(4))
            return dict(kind='approve', multisig=multisig, proposal=proposal,
                        call=child, childHex=hx(child_raw))
        if pallet == 9 and tag == 2:
            need(depth == 0 and not in_batch, 'nested batch')
            size = r.comp()
            need(size <= MAX_BATCH_CALLS, 'batch size')
            return dict(kind='batch', calls=[one(True) for _ in range(size)])
        raise ValueError('unrecognized call')
    value = one()
    r.end()
    return value


def pay_bytes(to, amount):
    return b'\x02\x03\x00' + unhex(to, 32) + compact(amount)


def fee_batch_hex(payload, fee):
    # utility.batch_all([system.remark_with_event(payload), balances.transfer_keep_alive(FEE, fee)])
    raw = unhex(payload)
    return hx(b'\x09\x02' + compact(2) + b'\x00\x07' + compact(len(raw)) + raw
              + pay_bytes(FEE_ACCOUNT, fee))


def batch_events_ok(events, sender, to, amount):
    # exactly one remark by sender, one payment sender -> to of amount, one batchCompleted
    remarked = [e for e in events if e['kind'] == 'remarked']
    paid = [e for e in events if e['kind'] == 'paid']
    return (len(remarked) == 1 and remarked[0]['sender'] == sender and len(paid) == 1
            and paid[0]['from'] == sender and paid[0]['to'] == to and int(paid[0]['amount']) == amount
            and sum(e['kind'] == 'batchCompleted' for e in events) == 1)


def declared_payload(c):
    # Candidate QLYP-v1 payload by call shape only; acceptance is decided by apply_op.
    payload = None
    if c['kind'] == 'remark' and c['event']:
        payload = c['payload']
    elif c['kind'] == 'propose' and c['call']['kind'] == 'remark' and not c['call']['event']:
        payload = c['call']['payload']
    elif c['kind'] == 'batch':
        for x in c['calls']:
            if x['kind'] == 'remark' and x['payload'].startswith(HEADER_HEX):
                payload = x['payload']
                break
    return payload if payload is not None and payload.startswith(HEADER_HEX) else None


def event_int(value):
    # An integer event field: an int from the RPC decoder, a canonical decimal string from JSON
    # receipts. Anything else is None, never coerced.
    if type(value) is int:
        return value
    if isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]{0,38}', value):
        return int(value)
    return None


def pair_key(signers):
    # A 2-of-2 signer pair in the pallet's sorted order, whatever order it was given in.
    return ':'.join(sorted(signers))


def settlement_hex(signers, nonce, fee):
    # utility.batch_all([multisig.create_multisig(signers, 2, nonce), transfer_keep_alive(FEE, fee)])
    create = b'\x13\x00' + compact(2) + signers[0] + signers[1] + (2).to_bytes(4, 'little') + nonce.to_bytes(8, 'little')
    return hx(b'\x09\x02' + compact(2) + create + pay_bytes(FEE_ACCOUNT, fee))


def purchase_bytes(t):
    p = t['offer']
    child = unhex(t['callHex'])
    first = b'\x13\x02' + unhex(t['multisig']) + t['proposal'].to_bytes(4, 'little') + compact(len(child)) + child
    def pay(to, amount):
        return b'\x02\x03\x00' + unhex(to) + compact(amount)
    out = b'\x09\x02' + compact(3 if p['fee'] else 2) + first + pay(p['payout'], p['price'])
    if p['fee']:
        out += pay(p['feeTo'], p['fee'])
    return hx(out)


def parse_rules(rules):
    # {'progressive': A, 'progressiveV2': B, 'feeSchedule': F}: A and B each None or {'from': height
    # >= 1}, F None or a fee schedule exactly as fee_schedule.parse_fee_rules reads it, nothing else.
    need(isinstance(rules, dict) and set(rules) == {'progressive', 'progressiveV2', 'feeSchedule'}, 'rules')
    heights = []
    for key in ('progressive', 'progressiveV2'):
        p = rules[key]
        need(p is None or (isinstance(p, dict) and set(p) == {'from'} and type(p['from']) is int
                           and 1 <= p['from'] <= 2**53 - 1), 'progressive activation')
        heights.append(None if p is None else p['from'])
    return heights[0], heights[1], None if rules['feeSchedule'] is None else parse_fee_rules(rules['feeSchedule'])


PINNED = object()


def mainnet_rules_allowed(rules, activation_height, reviewed=PINNED, fees=PINNED):
    # Exactly the reviewed mainnet rules: never progressive-1000-v1, progressive-1000-v2 and the fee
    # schedule from one reviewed height after the block QLYP starts reading, with the legacy fees
    # kept below it and for `grace` blocks after it. Unlike the TypeScript reader, this verifier
    # refuses mainnet altogether until both pins are set. The pins are read at call time, so that
    # a test can stand for the activation release.
    reviewed = MAINNET_PROGRESSIVE_V2_FROM if reviewed is PINNED else reviewed
    fees = MAINNET_FEE_SCHEDULE if fees is PINNED else fees
    v1, v2, schedule = parse_rules(rules)
    if reviewed is None or fees is None:
        return False
    pinned = parse_fee_rules(fees)
    return (v1 is None and v2 == reviewed and schedule == pinned and pinned['from'] == reviewed
            and pinned['legacyBefore'] is True and type(activation_height) is int
            and reviewed > activation_height > 0)


def fee_mode(schedule, h):
    # How rate-derived fees are read at height h: the fixed legacy fees, the schedule, or not at
    # all. Without a schedule every network, mainnet included, reads the legacy fees.
    if schedule is None:
        return 'legacy'
    if h >= schedule['from']:
        return 'schedule'
    return 'legacy' if schedule['legacyBefore'] else 'inactive'


class Ledger:
    def __init__(self, genesis, activation, rules):
        unhex(genesis, 32)
        need(genesis != MAINNET or mainnet_rules_allowed(rules, activation['height']), 'mainnet disabled')
        self.progressive_from, self.progressive_v2_from, self.fee_rules = parse_rules(rules)
        # The fee state is installed at `from`, a block this ledger applies.
        need(self.fee_rules is None or self.fee_rules['from'] > activation['height'], 'fee schedule start')
        self.fees = None
        self.genesis, self.activation = genesis, activation
        self.height, self.hash = activation['height'], activation['hash']
        self.assets, self.balances, self.sequences, self.multisigs, self.tickets = {}, {}, {}, {}, {}
        self.symbols, self.inscriptions, self.next_inscription = {}, {}, FIRST_INSCRIPTION
        self.finalized = activation['height']

    def change(self, asset, owner, amount):
        key = asset + ':' + owner
        result = self.balances.get(key, 0) + amount
        need(result >= 0, 'insufficient tokens')
        self.balances[key] = result

    def release(self, t):
        if t['status'] == 'locked':
            self.change(t['offer']['asset'], t['seller'], t['offer']['amount'])
            t['status'] = 'released'

    def invariants(self, progressive=True):
        # advance() checks the progressive section once per block: after every receipt it would cost
        # receipts x assets.
        need(all(v >= 0 for v in self.balances.values()))
        for asset, a in self.assets.items():
            total = sum(v for k, v in self.balances.items() if k.startswith(asset + ':'))
            total += sum(t['offer']['amount'] for t in self.tickets.values() if t['offer']['asset'] == asset and t['status'] == 'locked')
            need(total == a['minted'] and total <= a['op']['cap'], 'supply conservation')
            if a['op']['policy'] == 'inscription':
                need(asset in self.inscriptions and a['minted'] == 1, 'inscription supply')
            else:
                need(self.symbols.get(a['op']['symbol']) == asset, 'symbol index')
            if a['op']['policy'] not in PROFILES:
                need('right' not in a, 'right on a non-progressive asset')
            elif progressive:
                q = progressive_mint_quote(a['op']['cap'], a['minted'], PROFILES[a['op']['policy']])
                need(a['op']['limit'] == q['lotSize'] and (a['right'] is None) == (q['remainingLots'] == 0), 'progressive asset')
                if a['right'] is not None:
                    right = a['right']
                    need(set(right) == {'height', 'hash', 'index'} and type(right['height']) is int and type(right['index']) is int, 'progressive right')
                    unhex(right['hash'], 32)
                    need(0 <= right['height'] <= self.height and 0 <= right['index'] <= 0xffffffff, 'progressive right')
                    need(right['height'] < self.height or right['hash'] == self.hash, 'progressive right')
        need(len(self.symbols) == sum(a['op']['policy'] != 'inscription' for a in self.assets.values()), 'symbol index')
        need(self.next_inscription == FIRST_INSCRIPTION + len(self.inscriptions), 'inscription counter')
        need(len({x['number'] for x in self.inscriptions.values()}) == len(self.inscriptions), 'inscription numbers')
        need((self.fees is not None) == self.fee_active(), 'fee state')
        if self.fees is not None:
            fee_invariants(self.fees, self.height, self.fee_rules['grace'])

    def active(self):
        return self.progressive_from is not None and self.height >= self.progressive_from

    def active_v2(self):
        return self.progressive_v2_from is not None and self.height >= self.progressive_v2_from

    def fee_active(self):
        return self.fee_rules is not None and self.height >= self.fee_rules['from']

    def check_context(self, receipt, c, payload, p):
        owner, kind, events = receipt['signer'], p['kind'], receipt['events']
        legacy = is_rate_derived(kind) and fee_mode(self.fee_rules, self.height) == 'legacy'
        if kind == 'mint' or legacy:
            # Today's exact-fee rule: MINT at every height, the rate-derived kinds in the legacy reading.
            fee = MINT_FEE if kind == 'mint' else legacy_fee(kind)
            need(c['kind'] == 'batch', 'fee batch required')
            need(receipt['callHex'] == fee_batch_hex(payload, fee), 'exact fee batch')
            need(batch_events_ok(events, owner, FEE_ACCOUNT, fee), 'fee batch events')
        elif is_rate_derived(kind):
            # The amount is whatever the transfer leg pays; the rest of the batch is fixed byte for byte.
            need(c['kind'] == 'batch', 'fee batch required')
            need(len(c['calls']) == 2 and c['calls'][1]['kind'] == 'pay', 'fee batch shape')
            amount = c['calls'][1]['amount']
            need(receipt['callHex'] == fee_batch_hex(payload, amount), 'exact fee batch')
            need(self.fee_active(), 'fee schedule not active')
            need(kind == 'inscribe' or p['symbol'] not in BLOCKED, 'symbol blocked')
            # No fee check reads a role: a role set between signing and inclusion costs no one a fee.
            need(amount in allowed_fees(self.fees, self.fee_rules, p, self.height), 'fee schedule amount')
            need(batch_events_ok(events, owner, FEE_ACCOUNT, amount), 'fee batch events')
        elif kind in ('feeRate', 'feeAdmin'):
            # The native extrinsic signature is the governance signature: only a direct call has one signer.
            remarked = [e for e in events if e['kind'] == 'remarked']
            need(c['kind'] == 'remark' and c['event'] and len(remarked) == 1 and remarked[0]['sender'] == owner,
                 'fee schedule context')
        elif kind == 'transfer':
            need(c['kind'] == 'remark' and c['event'], 'transfer context')
            need(any(e['kind'] == 'remarked' and e['sender'] == owner for e in events), 'remark event')
        else:
            need(c['kind'] == 'propose', 'offer context')

    def apply_op(self, receipt, c, payload):
        genesis, sequence, p = operation(unhex(payload), self.active(), self.active_v2(), self.fee_active())
        owner = receipt['signer']
        need(owner is not None and owner != ZERO)
        unhex(owner, 32)
        need(genesis == self.genesis and sequence == self.sequences.get(owner, 0) and sequence < 2**64 - 1)
        self.check_context(receipt, c, payload, p)
        if p['kind'] == 'feeRate':
            self.fees = apply_fee_rate(self.fees, self.fee_rules, owner, p, self.height, receipt['index'])
        elif p['kind'] == 'feeAdmin':
            self.fees = apply_fee_admin(self.fees, self.fee_rules, owner, p, self.height)
        elif p['kind'] in ('deployProgressive', 'deployProgressiveV2'):
            policy = 'progressive' if p['kind'] == 'deployProgressive' else 'progressive-v2'
            progressive_mint_quote(p['cap'], 0, PROFILES[policy])
            asset = hx(unhex(owner) + sequence.to_bytes(8, 'little'))
            need(asset not in self.assets and p['symbol'] not in self.symbols)
            raw = bytearray(unhex(payload)); raw[37:45] = bytes(8)
            op = dict(kind=p['kind'], symbol=p['symbol'], decimals=p['decimals'], cap=p['cap'],
                      limit=p['cap'] // 1000, policy=policy)
            self.symbols[p['symbol']] = asset
            # The first right is this DEPLOY itself: usable from the next block on.
            self.assets[asset] = dict(creator=owner, op=op, definition=hx(raw), minted=0,
                                      right=dict(height=self.height, hash=self.hash, index=receipt['index']))
        elif p['kind'] in ('deploy', 'inscribe'):
            asset = hx(unhex(owner) + sequence.to_bytes(8, 'little'))
            need(asset not in self.assets)
            # Definition in signed snapshots is normalized to sequence zero.
            raw = bytearray(unhex(payload)); raw[37:45] = bytes(8)
            if p['kind'] == 'deploy':
                # Unique symbols (DEPLOY): the first valid claim wins.
                need(p['symbol'] not in self.symbols, 'symbol taken')
                self.symbols[p['symbol']] = asset
            if p['kind'] == 'inscribe':
                op = dict(kind='inscribe', symbol='', decimals=0, cap=1, limit=0, policy='inscription')
                self.assets[asset] = dict(creator=owner, op=op, definition=hx(raw), minted=1)
                self.change(asset, owner, 1)
                self.inscriptions[asset] = dict(number=self.next_inscription, id=asset, creator=owner,
                                                contentType=p['contentType'], content=p['content'],
                                                height=self.height, index=receipt['index'])
                self.next_inscription += 1
            else:
                self.assets[asset] = dict(creator=owner, op=p, definition=hx(raw), minted=0)
        else:
            need(p['asset'] in self.assets)
            a = self.assets[p['asset']]
            if a['op']['policy'] == 'inscription':
                # An inscription is never minted and always moves whole.
                need(p['kind'] != 'mint' and p['amount'] == 1, 'inscription amount')
            if p['kind'] == 'mint':
                # A progressive asset mints only through its native right.
                need(a['op']['policy'] not in PROFILES, 'progressive asset')
                need(a['op']['policy'] == 'open' or a['creator'] == owner)
                need(p['amount'] <= a['op']['limit'] and a['minted'] + p['amount'] <= a['op']['cap'])
                a['minted'] += p['amount']
                self.change(p['asset'], owner, p['amount'])
            elif p['kind'] == 'transfer':
                need(p['to'] != ZERO)
                self.change(p['asset'], owner, -p['amount'])
                self.change(p['asset'], p['to'], p['amount'])
            else:
                need(c['kind'] == 'propose' and c['expiry'] == p['expiry'])
                need(self.height < p['expiry'] <= self.height + 100800)
                need(p['buyer'] not in (owner, ZERO) and p['payout'] not in (p['buyer'], ZERO))
                need(p['fee'] == sale_fee(p['price']) and p['feeTo'] == FEE_ACCOUNT and p['feeTo'] != p['buyer'], 'sale fee')
                m = self.multisigs.get(c['multisig'])
                need(m and m['threshold'] == 2 and len(m['signers']) == 2 and owner in m['signers'] and p['buyer'] in m['signers'])
                events = [e for e in receipt['events'] if e['kind'] == 'created']
                need(len(events) == 1)
                ev = events[0]
                need(ev['multisig'] == c['multisig'] and ev['proposer'] == owner)
                key = c['multisig'] + ':' + str(ev['proposal'])
                need(key not in self.tickets)
                self.change(p['asset'], owner, -p['amount'])
                self.tickets[key] = dict(key=key, multisig=c['multisig'], proposal=ev['proposal'], seller=owner,
                                        offer=p, callHex=c['childHex'], createdHeight=self.height,
                                        status='locked', settlement=None)
        self.sequences[owner] = sequence + 1

    def ticket_of(self, asset):
        a = self.assets[asset]
        profile = PROFILES[a['op']['policy']]
        q = progressive_mint_quote(a['op']['cap'], a['minted'], profile)
        signers, nonce = mint_ticket(unhex(self.genesis, 32), unhex(asset, 40), q['mintedLots'],
                                     unhex(a['right']['hash'], 32), a['right']['index'], profile)
        return [hx(x) for x in signers], nonce, q

    def rights_by_pair(self):
        # Current rights by their ticket's signer pair, before this block's receipts. A right created
        # in this block is not listed (its ticket names this block's hash); a used one is removed.
        rights = {}
        for asset, a in sorted(self.assets.items()):
            if a.get('right') is not None:
                signers, _, _ = self.ticket_of(asset)
                rights[pair_key(signers)] = asset
        return rights

    def right_used(self, e, rights):
        # The progressive asset whose current right this creation uses, if any.
        if e['threshold'] != 2 or len(e['signers']) != 2:
            return None
        asset = rights.get(pair_key(e['signers']))
        if asset is None:
            return None
        nonce = event_int(e.get('nonce'))
        need(nonce is not None and 0 <= nonce < 2**64 and isinstance(e.get('creator'), str),
             'multisig event without creator/nonce')
        # Same signers, another nonce: another multisig, not this right.
        return asset if nonce == self.ticket_of(asset)[1] else None

    def use_rights(self, r, used, rights):
        for asset in used:
            a = self.assets[asset]
            signers, nonce, q = self.ticket_of(asset)
            rights.pop(pair_key(signers), None)
            fee, owner = q['nextFee'], r['signer']
            relevant = [e for e in r['events'] if e['kind'] in ('multisig', 'paid', 'batchCompleted')]
            exact = (len(used) == 1 and r['success'] and owner not in (None, ZERO, FEE_ACCOUNT)
                     and r['callHex'] == settlement_hex([unhex(x) for x in signers], nonce, fee)
                     and len(relevant) == 3 and relevant[0]['kind'] == 'multisig'
                     and relevant[0].get('creator') == owner and pair_key(relevant[0]['signers']) == pair_key(signers)
                     and event_int(relevant[0].get('nonce')) == nonce and relevant[1]['kind'] == 'paid'
                     and relevant[1]['from'] == owner and relevant[1]['to'] == FEE_ACCOUNT
                     and event_int(relevant[1]['amount']) == fee and relevant[2]['kind'] == 'batchCompleted')
            if exact:
                a['minted'] += q['lotSize']
                self.change(asset, owner, q['lotSize'])
            # Any use ends the right; the next one, if a lot remains, is anchored here.
            a['right'] = None if a['minted'] == a['op']['cap'] else dict(height=self.height, hash=self.hash, index=r['index'])

    def receipt(self, r, rights):
        used = []
        for e in r['events']:
            if e['kind'] == 'multisig':
                asset = self.right_used(e, rights) if rights is not None else None
                if asset is not None:
                    need(asset not in used, 'duplicate right use')
                    used.append(asset)
                    continue
                need(e['id'] not in self.multisigs, 'duplicate multisig')
                unhex(e['id'], 32)
                for account in e['signers']:
                    unhex(account, 32)
                self.multisigs[e['id']] = dict(signers=e['signers'][:], threshold=e['threshold'])
        payload, c = None, None
        if r['success'] and r['signer'] is not None:
            try:
                c = call(unhex(r['callHex']))
            except ValueError:
                pass
            payload = declared_payload(c) if c else None
            if payload is not None:
                saved = copy.deepcopy((self.assets, self.balances, self.sequences, self.tickets,
                                       self.symbols, self.inscriptions, self.next_inscription, self.fees))
                try:
                    self.apply_op(r, c, payload)
                except (ValueError, UnicodeError):
                    (self.assets, self.balances, self.sequences, self.tickets,
                     self.symbols, self.inscriptions, self.next_inscription, self.fees) = saved
        if used:
            self.use_rights(r, used, rights)
        for e in r['events']:
            if e['kind'] not in ('approved', 'closed'):
                continue
            t = self.tickets.get(e['multisig'] + ':' + str(e['proposal']))
            if not t or t['status'] != 'locked':
                continue
            if e['kind'] == 'closed':
                self.release(t)
                continue
            if e['approver'] != t['offer']['buyer']:
                continue
            p = t['offer']
            payments = [ev for ev in r['events'] if ev['kind'] == 'paid']
            expected = [(p['payout'], p['price'])] + ([(p['feeTo'], p['fee'])] if p['fee'] else [])
            valid = (r['success'] and r['signer'] == p['buyer'] and r['callHex'] == purchase_bytes(t)
                     and sum(ev['kind'] == 'batchCompleted' for ev in r['events']) == 1
                     and sum(ev['kind'] == 'approved' for ev in r['events']) == 1
                     and len(payments) == len(expected)
                     and all(ev['from'] == p['buyer'] and ev['to'] == target and int(ev['amount']) == amount
                             for ev, (target, amount) in zip(payments, expected)))
            if valid:
                self.change(p['asset'], p['buyer'], p['amount'])
                t.update(status='settled', settlement=r['hash'])
            else:
                self.release(t)
        self.invariants(progressive=False)

    def advance(self, b):
        need(b['spec'] == 152 and b['txVersion'] == 6, 'runtime')
        need(type(b['height']) is int and b['height'] == self.height + 1 and b['parent'] == self.hash, 'continuity')
        need(b['finalized'] == b['height'], 'finalized only')
        unhex(b['hash'], 32); need(b['hash'] != b['parent'])
        backup = copy.deepcopy(self.__dict__)
        try:
            self.height, self.hash, self.finalized = b['height'], b['hash'], b['finalized']
            for t in self.tickets.values():
                if self.height > t['offer']['expiry']:
                    self.release(t)
            self.fees = step_fees(self.fees, self.fee_rules, self.height)
            # Built only for blocks that create a 2-of-2 multisig: nothing else can use a right.
            rights = None
            if (self.active() or self.active_v2()) and any(e['kind'] == 'multisig' and e['threshold'] == 2 and len(e['signers']) == 2
                                     for r in b['receipts'] for e in r['events']):
                rights = self.rights_by_pair()
            last = -1
            for r in b['receipts']:
                need(type(r['index']) is int and last < r['index'], 'receipt order')
                unhex(r['hash'], 32)
                last = r['index']
                self.receipt(r, rights)
            self.invariants()
            need(sum(len(x) for x in (self.assets, self.balances, self.sequences, self.multisigs, self.tickets,
                                      self.symbols, self.inscriptions)) <= 100000,
                 'resource bound')
        except Exception:
            self.__dict__ = backup
            raise

    def snapshot(self):
        return dict(format=2, height=self.height, hash=self.hash,
                    assets=[dict(id=k, creator=v['creator'], definition=v['definition'], minted=str(v['minted']),
                                 **({'right': dict(v['right']) if v['right'] is not None else None} if 'right' in v else {}))
                            for k, v in sorted(self.assets.items())],
                    balances=[dict(key=k, amount=str(v)) for k, v in sorted(self.balances.items()) if v > 0],
                    sequences=[dict(owner=k, value=str(v)) for k, v in sorted(self.sequences.items())],
                    multisigs=[dict(id=k, threshold=v['threshold'], signers=sorted(v['signers'])) for k, v in sorted(self.multisigs.items())],
                    tickets=[{name: t[name] for name in ('key','multisig','proposal','seller','callHex','createdHeight','status','settlement')} for k, t in sorted(self.tickets.items())],
                    symbols=[dict(symbol=k, asset=v) for k, v in sorted(self.symbols.items())],
                    inscriptions=[dict(v) for v in sorted(self.inscriptions.values(), key=lambda x: x['number'])],
                    nextInscription=self.next_inscription, fees=snapshot_fees(self.fees))


def main():
    ledger = None
    rpc_node = None
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            break
        need(len(line) <= MAX_LINE and line.endswith(b'\n'), 'input limit')
        m = json.loads(line)
        if m['kind'] == 'init':
            need(ledger is None, 'already initialized')
            # The TypeScript witness passes its own digest: both engines must refuse the same tickers.
            need(m.get('tickersDigest') == TICKERS_DIGEST, 'tickers digest')
            ledger = Ledger(m['genesis'], m['activation'], m['rules'])
            if 'rpcUrl' in m:
                from rpc import Node
                rpc_node = Node(m['rpcUrl'], m['schema'], m['genesis'], m['runtimeHash'], m['runtime'])
        elif m['kind'] == 'block':
            need(ledger is not None, 'not initialized')
            ledger.advance(rpc_node.block(m['height'], m['hash']) if rpc_node else m['block'])
        elif m['kind'] == 'tip':
            # The state at a best block, computed on a copy: the ledger stays at its finalized height.
            # A tip that cannot be computed is refused alone; it never stops finalized replay.
            need(ledger is not None, 'not initialized')
            try:
                blocks = m['blocks']
                need(isinstance(blocks, list) and 0 < len(blocks) <= 256, 'tip blocks')
                # Epoch milliseconds past which the tip is refused, and bytes it may read from the
                # node: both checked on every node call.
                deadline = m.get('deadline')
                if rpc_node:
                    rpc_node.limit(deadline, m.get('budget'))
                tip = copy.deepcopy(ledger)
                for b in blocks:
                    need(deadline is None or time.time() * 1000 < deadline, 'tip deadline')
                    tip.advance(rpc_node.block(b['height'], b['hash'], final=False) if rpc_node else b['block'])
                out = tip.snapshot()
            except Exception:
                out = dict(error='tip refused')
            finally:
                if rpc_node:
                    rpc_node.limit(None, None)
            print(json.dumps(out, sort_keys=True, separators=(',', ':')), flush=True)
            continue
        else:
            raise ValueError('unsupported request')
        print(json.dumps(ledger.snapshot(), sort_keys=True, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No input or secret material is echoed, and the process stops instead of skipping a block.
        print('Independent replay stopped: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
