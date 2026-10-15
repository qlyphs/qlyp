"""Python-only fee schedule checks against the shared vectors (run by fee-schedule-parity.test.mjs).

Usage: python3 -I fee_schedule_witness.py <vectors.json> <TypeScript TICKERS_DIGEST>
"""
import copy
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'verifier'))
import fee_schedule as fs
import replay
import tickers

checks = 0


def check(ok, what):
    global checks
    if not ok:
        raise AssertionError(what)
    checks += 1


def refused(fn, what):
    try:
        fn()
    except ValueError:
        check(True, what)
        return
    raise AssertionError(what + ' was accepted')


def as_json(p):
    return {k: str(v) if k == 'rate' else v for k, v in p.items()}


vectors = json.loads(Path(sys.argv[1]).read_text())
ts_digest = sys.argv[2]

# Section 3: the pinned literals agree across languages, and the import-time recomputation ran.
check(tickers.TICKERS_DIGEST == ts_digest == vectors['tickersDigest'], 'TICKERS_DIGEST literal')
check(replay.TICKERS_DIGEST == tickers.TICKERS_DIGEST, 'replay digest')
check(tickers.BLOCKED == ('BTC', 'ETH', 'QLYPHS', 'QTC', 'USDC', 'USDT'), 'BLOCKED')

# Codec: tags 13 and 14 decode exactly where the TypeScript codec does, to the same operation.
for e in vectors['encodings']:
    v1, v2, schedule = replay.parse_rules(e['rules'])
    active = schedule is not None and e['height'] >= schedule['from']
    try:
        _, _, op = replay.operation(replay.unhex(e['hex']), v1 is not None and e['height'] >= v1,
                                    v2 is not None and e['height'] >= v2, active)
        ok = True
    except ValueError:
        ok = False
    check(ok == e['ok'], 'encoding: ' + e['name'])
    if ok:
        check(as_json(op) == e['op'], 'decoded: ' + e['name'])

# fee(): every class and reference rate, and the existential-deposit floor.
for f in vectors['fees']:
    rate = int(f['rate'])
    if f['kind'] == 'target':
        check(fs.fee_at(int(f['cents']), rate) == int(f['fee']) == fs.ED, 'ED floor')
        continue
    op = {'kind': f['kind'], 'symbol': f.get('symbol')}
    check(fs.fee(op, rate) == int(f['fee']), 'fee %s %s' % (f['kind'], f['rate']))
check(fs.fee_at(1, fs.RATE_MIN) == fs.ED and 1 * fs.RATE_MIN // 100 < fs.ED, 'floor below target')
for r in vectors['checkRate']:
    check(fs.check_rate(int(r['rate'])) == r['ok'], 'checkRate ' + r['rate'])
check(not fs.check_rate(True) and not fs.check_rate(float(fs.RATE_MIN)), 'checkRate types')

# MINT is fee-bearing and not rate-derived: no target, no rate-derived fee.
check(fs.is_fee_bearing('mint') and not fs.is_rate_derived('mint'), 'mint kind')
check(not fs.is_fee_bearing('transfer') and not fs.is_fee_bearing('feeRate'), 'fee-free kinds')
refused(lambda: fs.cents_for({'kind': 'mint'}), 'centsFor(mint)')
refused(lambda: fs.fee({'kind': 'mint'}, 10_000_000_000), 'fee(mint)')
refused(lambda: fs.legacy_fee('mint'), 'legacyFee(mint)')
for s in tickers.BLOCKED:
    refused(lambda: fs.fee({'kind': 'deploy', 'symbol': s}, 10_000_000_000), 'blocked ' + s)
for s in ('USDT0', 'WBTC', 'BTC1', 'Q'):
    check(fs.fee({'kind': 'deployProgressiveV2', 'symbol': s}, 10_000_000_000) == 250_000_000_000, 'allowed ' + s)

# Strict rules: every key, exact types, the rate as a canonical decimal string.
good = next(c['head']['rules'] for c in vectors['cases'] if c['head']['rules']['feeSchedule'] is not None)
fees = good['feeSchedule']
check(replay.parse_rules(good)[2]['rate'] == int(fees['rate']), 'rules parse')


def bad_fees(**change):
    f = dict(copy.deepcopy(fees), **change)
    return {**good, 'feeSchedule': {k: v for k, v in f.items() if v != '<drop>'}}


role = fees['operator']
other = '0x' + 'ab' * 32
for name, rules in [
    ('2-key rules', {'progressive': None, 'progressiveV2': None}),
    ('extra key', {**good, 'extra': None}),
    ('rate as a number', bad_fees(rate=int(fees['rate']))),
    ('rate with a leading zero', bad_fees(rate='0' + fees['rate'])),
    ('rate with a sign', bad_fees(rate='+' + fees['rate'])),
    ('rate with a newline', bad_fees(rate=fees['rate'] + '\n')),
    ('rate not canonical', bad_fees(rate='12340000000')),
    ('rate out of bounds', bad_fees(rate='199999900')),
    ('missing key', bad_fees(resets='<drop>')),
    ('extra fee key', bad_fees(extra=1)),
    ('boolean height', bad_fees(**{'from': True})),
    ('float height', bad_fees(**{'from': 10.0})),
    ('height 0', bad_fees(**{'from': 0})),
    ('grace below 320', bad_fees(grace=319)),
    ('grace not below delay', bad_fees(grace=fees['delay'])),
    ('delay too long', bad_fees(delay=1_000_001, guardianDelay=1_000_001)),
    ('guardianDelay below delay', bad_fees(guardianDelay=fees['delay'] - 1)),
    ('legacyBefore as an integer', bad_fees(legacyBefore=1)),
    ('equal roles', bad_fees(guardian=role)),
    ('zero role', bad_fees(sentinel=fs.ZERO)),
    ('fee account role', bad_fees(sentinel=fs.FEE_ACCOUNT)),
    ('uppercase role', bad_fees(sentinel=other.upper().replace('0X', '0x'))),
    ('reset at from', bad_fees(resets=[{'at': fees['from'], 'operator': other, 'guardian': role,
                                        'sentinel': fees['sentinel']}])),
    ('too many resets', bad_fees(resets=[{'at': fees['from'] + 1 + i, 'operator': fees['operator'],
                                          'guardian': fees['guardian'], 'sentinel': fees['sentinel']}
                                         for i in range(9)])),
]:
    refused(lambda: replay.parse_rules(rules), name)
check(replay.parse_rules(bad_fees(resets=[{'at': fees['from'] + 1, 'operator': other, 'guardian': fees['guardian'],
                                          'sentinel': fees['sentinel']}]))[2]['resets'][0]['operator'] == other,
      'a valid reset')

print('ok', checks)
