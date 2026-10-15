"""Independent test-only replay of the progressive lot settlement lifecycle, not production replay."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'apps/native/verifier'))
from progressive_mint import progressive_mint_quote

ZERO = '0x' + '00' * 32
DOMAIN = b'Qlyphs/ProgressiveMint/right/v1\0'


def need(ok, message):
    if not ok:
        raise ValueError(message)


def raw(value, size=None):
    need(isinstance(value, str) and re.fullmatch(r'0x(?:[0-9a-f]{2})*', value), 'noncanonical hex')
    result = bytes.fromhex(value[2:])
    need(size is None or len(result) == size, 'wrong byte length')
    return result


def number(value):
    need(isinstance(value, str) and re.fullmatch(r'(0|[1-9][0-9]{0,38})', value), 'noncanonical amount')
    return int(value)


def position(value):
    need(type(value) is int and 0 <= value <= 0xffffffff, 'invalid position')


def state_check(s):
    position(s['height'])
    for field, length in [('hash', 32), ('asset', 40), ('genesis', 32), ('feeTo', 32)]:
        raw(s[field], length)
    need(s['feeTo'] != ZERO, 'zero fee recipient')
    q = progressive_mint_quote(number(s['cap']), number(s['minted']))
    total = 0
    for owner, amount in s['balances'].items():
        raw(owner, 32)
        total += number(amount)
    need(total == number(s['minted']), 'supply conservation')
    number(s['collected'])
    need((s['anchor'] is None) == (q['remainingLots'] == 0), 'right/exhaustion mismatch')
    if s['anchor'] is not None:
        a = s['anchor']
        position(a['height']); position(a['index']); raw(a['hash'], 32)
        need(a['height'] <= s['height'], 'future anchor')
        if a['height'] == s['height']:
            need(a['hash'] == s['hash'], 'anchor/head mismatch')


def right(s):
    state_check(s)
    q = progressive_mint_quote(number(s['cap']), number(s['minted']))
    if q['nextFee'] is None:
        return None
    digest = hashlib.sha512(DOMAIN + raw(s['genesis'], 32) + raw(s['asset'], 40)
                            + q['mintedLots'].to_bytes(2, 'little')).digest()[:32]
    signers = sorted(['0x' + digest.hex(), s['anchor']['hash']])
    need(signers[0] != signers[1], 'ticket signer collision')
    return dict(asset=s['asset'], lot=str(q['mintedLots']+1), amount=str(q['lotSize']),
                fee=str(q['nextFee']), feeTo=s['feeTo'], signers=signers, threshold=2,
                nonce=str(s['anchor']['index']), anchor=copy.deepcopy(s['anchor']))


def compact(n):
    need(0 <= n < 2**128, 'compact overflow')
    if n < 2**6:
        return (n << 2).to_bytes(1, 'little')
    if n < 2**14:
        return ((n << 2) | 1).to_bytes(2, 'little')
    if n < 2**30:
        return ((n << 2) | 2).to_bytes(4, 'little')
    width = max(4, (n.bit_length()+7)//8)
    return bytes([((width-4) << 2) | 3]) + n.to_bytes(width, 'little')


def create_bytes(r):
    return b'\x13\x00\x08' + b''.join(raw(s, 32) for s in r['signers']) + (2).to_bytes(4, 'little') + number(r['nonce']).to_bytes(8, 'little')


def settlement_hex(r):
    return '0x' + (b'\x09\x02\x08' + create_bytes(r) + b'\x02\x03\x00'
                   + raw(r['feeTo'], 32) + compact(number(r['fee']))).hex()


def ticket(e, r):
    return e.get('kind') == 'created' and type(e.get('threshold')) is int and e['threshold'] == 2 and e.get('nonce') == r['nonce'] and e.get('signers') == r['signers']


def apply_block(state, b):
    state_check(state)
    position(b['height']); raw(b['hash'], 32); raw(b['parent'], 32)
    need(b['height'] == state['height']+1 and b['parent'] == state['hash'] and b['hash'] != b['parent'], 'noncontiguous block')
    need(isinstance(b['receipts'], list), 'invalid receipts')
    out = copy.deepcopy(state)
    out['height'], out['hash'] = b['height'], b['hash']
    prev = -1
    for receipt in b['receipts']:
        position(receipt['index'])
        need(receipt['index'] > prev, 'unordered receipts')
        prev = receipt['index']
        signer = receipt['signer']
        need(signer is None or (isinstance(signer, str) and re.fullmatch(r'0x[0-9a-f]{64}', signer)), 'invalid signer')
        need(type(receipt['success']) is bool and isinstance(receipt['events'], list), 'invalid receipt')
        raw(receipt['callHex'])
        r = right(out)
        if r is None:
            continue
        matches = [e for e in receipt['events'] if ticket(e, r)]
        if not matches:
            continue
        need(len(matches) == 1, 'duplicate native ticket creation')
        need(b['height'] > r['anchor']['height'], 'same-block ticket consumption')
        events = [e for e in receipt['events'] if e.get('kind') in ('created', 'paid', 'completed')]
        canonical = False
        if len(events) == 3:
            creation, payment, completed = events
            canonical = (receipt['success'] is True and signer not in (None, ZERO, out['feeTo'])
                         and receipt['callHex'] == settlement_hex(r) and creation is matches[0]
                         and creation.get('creator') == signer and payment.get('kind') == 'paid'
                         and payment.get('from') == signer and payment.get('to') == r['feeTo']
                         and payment.get('amount') == r['fee'] and completed.get('kind') == 'completed')
        if canonical:
            out['minted'] = str(number(out['minted'])+number(r['amount']))
            out['balances'][signer] = str(number(out['balances'].get(signer, '0'))+number(r['amount']))
            out['collected'] = str(number(out['collected'])+number(r['fee']))
        out['anchor'] = None if out['minted'] == out['cap'] else dict(height=b['height'], hash=b['hash'], index=receipt['index'])
    state_check(out)
    return out


def main():
    data = sys.stdin.buffer.read(16*1024*1024+1)
    need(len(data) <= 16*1024*1024, 'probe input too large')
    records = json.loads(data)
    need(isinstance(records, list) and len(records) <= 10000, 'invalid probe cases')
    results = []
    for case in records:
        try:
            s = case['state']
            for b in case.get('blocks', []):
                s = apply_block(s, b)
            r = right(s)
            results.append(dict(state=s, right=r, callHex=settlement_hex(r) if r else None))
        except (ValueError, KeyError, TypeError, OverflowError) as error:
            results.append(dict(error=str(error)))
    json.dump(results, sys.stdout, sort_keys=True, separators=(',', ':'))


if __name__ == '__main__':
    main()
