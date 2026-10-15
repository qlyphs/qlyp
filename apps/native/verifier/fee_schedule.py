"""Independent QLYP fee schedule (fees-1): rate-derived fees, the fee state and its governance.

Written from docs/extension/PROTOCOL-FEES.md, standard library only. Pure functions of chain data:
no clock, no network, no oracle. Every state returned is a new dict; inputs are never mutated.
"""
import copy
import hashlib
import json
import re
from tickers import BLOCKED, TICKERS_DIGEST

ZERO = '0x' + '00' * 32
FEE_ACCOUNT = '0x2139a57532fbf4764ad95754c17545fed7af915fb008b6494b02e503084da8b3'
ED = 1_000_000_000                       # 0.001 QTC, the existential deposit: the least fee
RATE_MIN = 200_000_000                   # QTC base units per USD at QTC = 5,000 USD
RATE_MAX = 200_000_000_000               # at QTC = 5 USD
STEP_NUM, STEP_DEN = 5, 4                # a new rate is within x4/5 .. x5/4 of the current one
LEGACY_DEPLOY_FEE = 1_000_000_000_000    # read only where the legacy reading applies (never mainnet)
LEGACY_INSCRIBE_FEE = 100_000_000_000
MINT_FEE = 10_000_000_000                # 0.01 QTC at every height: MINT is not rate-derived
FEE_TARGETS_CENTS = {'deploy': 2_500, 'inscribe': 2_500}
MIN_GRACE = 320
MAX_DELAY = 1_000_000
MAX_RESETS = 8
GENESIS_GRID_INDEX = 0xFFFFFFFF
U32_MAX = 0xFFFFFFFF                     # heights, grid ids and nextGrid are u32 in the state
SAFE = 2**53 - 1
ID = re.compile(r'0x[0-9a-f]{64}')
SYMBOL = re.compile(r'[A-Z0-9]{1,12}')
RULES_KEYS = {'from', 'operator', 'guardian', 'sentinel', 'rate', 'delay', 'grace', 'guardianDelay',
              'legacyBefore', 'resets'}
DEPLOY_KINDS = ('deploy', 'deployProgressive', 'deployProgressiveV2')


def need(ok, msg='invalid input'):
    if not ok:
        raise ValueError(msg)


# The blocked list is consensus data: refuse to load one that is malformed or that differs from the
# digest pinned next to it.
need(all(SYMBOL.fullmatch(s) for s in BLOCKED) and all(a < b for a, b in zip(BLOCKED, BLOCKED[1:])),
     'blocked tickers')
need(hashlib.sha512(b'Qlyphs/QLYP/tickers/v1\0' + json.dumps({'blocked': list(BLOCKED)}, separators=(',', ':'))
                    .encode()).hexdigest() == TICKERS_DIGEST, 'tickers digest')


def is_rate_derived(kind):
    return kind in DEPLOY_KINDS or kind == 'inscribe'


def is_fee_bearing(kind):
    return kind == 'mint' or is_rate_derived(kind)


def check_rate(r):
    # Within bounds and at most 3 significant digits, so every fee is an exact integer.
    return type(r) is int and RATE_MIN <= r <= RATE_MAX and r % 10 ** (len(str(r)) - 3) == 0


def cents_for(op):
    if op['kind'] in DEPLOY_KINDS:
        need(op['symbol'] not in BLOCKED, 'symbol blocked')
        return FEE_TARGETS_CENTS['deploy']
    need(op['kind'] == 'inscribe', 'the mint fee is not rate-derived')
    return FEE_TARGETS_CENTS['inscribe']


def fee_at(cents, rate):
    need(check_rate(rate), 'rate')
    need(type(cents) is int and cents >= 0, 'fee target')
    return max(ED, cents * rate // 100)


def fee(op, rate):
    return fee_at(cents_for(op), rate)


def legacy_fee(kind):
    need(is_rate_derived(kind), 'the mint fee is not rate-derived')
    return LEGACY_INSCRIBE_FEE if kind == 'inscribe' else LEGACY_DEPLOY_FEE


def _safe(v, low):
    need(type(v) is int and low <= v <= SAFE, 'fee schedule')
    return v


def _roles(o):
    roles = [o['operator'], o['guardian'], o['sentinel']]
    need(all(isinstance(x, str) and ID.fullmatch(x) and x not in (ZERO, FEE_ACCOUNT) for x in roles)
         and len(set(roles)) == 3, 'fee schedule')
    return dict(operator=roles[0], guardian=roles[1], sentinel=roles[2])


def parse_fee_rules(v):
    # Exactly the schedule the reducer accepts: every key, no extra key, no default. The rate is a
    # decimal string, never a JSON number, and is read only once its form is checked.
    need(isinstance(v, dict) and set(v) == RULES_KEYS, 'fee schedule')
    start = _safe(v['from'], 1)
    rate = v['rate']
    need(isinstance(rate, str) and re.fullmatch(r'[1-9][0-9]*', rate) is not None, 'fee schedule')
    rate = int(rate)
    need(check_rate(rate), 'fee schedule')
    delay, grace = _safe(v['delay'], 1), _safe(v['grace'], MIN_GRACE)
    guardian_delay = _safe(v['guardianDelay'], delay)
    # delay > grace keeps at most two rates acceptable at any height.
    need(grace < delay <= MAX_DELAY, 'fee schedule')
    # Every effective height a window allows from `from` fits the u32 state fields; guardianDelay
    # is at least delay, so its window bounds the others.
    need(start + 2 * guardian_delay <= U32_MAX, 'fee schedule')
    need(type(v['legacyBefore']) is bool, 'fee schedule')
    need(isinstance(v['resets'], list) and len(v['resets']) <= MAX_RESETS, 'fee schedule')
    resets, last = [], start
    for x in v['resets']:
        need(isinstance(x, dict) and set(x) == {'at', 'operator', 'guardian', 'sentinel'}, 'fee schedule')
        at = _safe(x['at'], 1)
        need(last < at <= U32_MAX, 'fee schedule')
        last = at
        resets.append(dict(at=at, **_roles(x)))
    return {'from': start, **_roles(v), 'rate': rate, 'delay': delay, 'grace': grace,
            'guardianDelay': guardian_delay, 'legacyBefore': v['legacyBefore'], 'resets': resets}


def genesis_fee_state(rules):
    grid = dict(id=0, rate=rules['rate'], effective=rules['from'], height=rules['from'], index=GENESIS_GRID_INDEX)
    return dict(operator=rules['operator'], guardian=rules['guardian'], sentinel=rules['sentinel'],
                pendingOperator=None, pendingGuardian=None, current=grid, previous=None, pending=None,
                nextGrid=1, nextReset=0)


def step_fees(fees, rules, h):
    # The block-start step for block h, before its receipts.
    if rules is None or h < rules['from']:
        return copy.deepcopy(fees)
    f = genesis_fee_state(rules) if h == rules['from'] else copy.deepcopy(fees)
    need(f is not None, 'fee state missing')
    while f['nextReset'] < len(rules['resets']) and rules['resets'][f['nextReset']]['at'] <= h:
        r = rules['resets'][f['nextReset']]
        f.update(operator=r['operator'], guardian=r['guardian'], sentinel=r['sentinel'],
                 pendingOperator=None, pendingGuardian=None, pending=None, nextReset=f['nextReset'] + 1)
    if f['pendingGuardian'] is not None and f['pendingGuardian']['effective'] <= h:
        f['guardian'], f['pendingGuardian'] = f['pendingGuardian']['account'], None
    if f['pendingOperator'] is not None and f['pendingOperator']['effective'] <= h:
        f['operator'], f['pendingOperator'] = f['pendingOperator']['account'], None
    if f['pending'] is not None and f['pending']['effective'] <= h:
        f['previous'], f['current'], f['pending'] = f['current'], f['pending'], None
    if f['previous'] is not None and h >= f['current']['effective'] + rules['grace']:
        f['previous'] = None
    return f


def allowed_fees(fees, rules, op, h):
    # At most two amounts, by the overlap bound; the legacy amount only in the legacy window.
    out = {fee(op, fees['current']['rate'])}
    if fees['previous'] is not None:
        out.add(fee(op, fees['previous']['rate']))
    if rules['legacyBefore'] and h < rules['from'] + rules['grace']:
        out.add(legacy_fee(op['kind']))
    return out


def _effective_in(effective, P, delay):
    need(P + delay <= effective <= P + 2 * delay, 'invalid effective height')


def apply_fee_rate(fees, rules, signer, op, P, index):
    need(fees['operator'] is not None, 'fee operator frozen')
    need(signer == fees['operator'], 'not the fee operator')
    _effective_in(op['effective'], P, rules['delay'])
    rate, c = op['rate'], fees['current']['rate']
    need(check_rate(rate), 'rate')
    # Against the current rate, never the pending grid it replaces: replacing cannot chain steps.
    need(STEP_DEN * rate <= STEP_NUM * c and STEP_NUM * rate >= STEP_DEN * c, 'rate step too large')
    # Ids are never reused and nextGrid is a u32: once the last id is spent, FEE_RATE is refused
    # like any invalid operation instead of reaching the state invariant, which halts the reader.
    need(fees['nextGrid'] < U32_MAX, 'grid ids exhausted')
    f = copy.deepcopy(fees)
    f['pending'] = dict(id=f['nextGrid'], rate=rate, effective=op['effective'], height=P, index=index)
    f['nextGrid'] += 1
    return f


def apply_fee_admin(fees, rules, signer, op, P):
    # Each set of excluded accounts is exactly what would break role distinctness.
    f = copy.deepcopy(fees)
    action = op['action']
    pending_op = f['pendingOperator'] and f['pendingOperator']['account']
    pending_g = f['pendingGuardian'] and f['pendingGuardian']['account']

    def allowed(account, *taken):
        need(account not in [x for x in taken if x is not None] + [ZERO, FEE_ACCOUNT], 'invalid fee account role')
    if action == 'cancel':
        need(signer in [x for x in (f['operator'], f['sentinel'], f['guardian']) if x is not None], 'not a fee role')
        need(f['pending'] is not None, 'no pending grid')
        f['pending'] = None
    elif action == 'freeze':
        need(signer in (f['sentinel'], f['guardian']), 'not the fee guardian or sentinel')
        f.update(operator=None, pendingOperator=None, pending=None)
    else:
        need(signer == f['guardian'], 'not the fee guardian')
        account = op['account']
        if action == 'setOperator':
            allowed(account, f['operator'], f['guardian'], f['sentinel'], pending_g)
            _effective_in(op['effective'], P, rules['delay'])
            f['pendingOperator'] = dict(account=account, effective=op['effective'])
        elif action == 'setGuardian':
            if account == f['guardian']:
                # Naming the current guardian aborts a rotation, whatever `effective` says.
                f['pendingGuardian'] = None
            else:
                allowed(account, f['operator'], f['sentinel'], pending_op)
                _effective_in(op['effective'], P, rules['guardianDelay'])
                f['pendingGuardian'] = dict(account=account, effective=op['effective'])
        else:
            need(action == 'setSentinel', 'fee admin action')
            # Immediate: the sentinel's powers are a protective subset of the guardian's.
            allowed(account, f['operator'], f['guardian'], f['sentinel'], pending_op, pending_g)
            f['sentinel'] = account
    return f


def _u32(n):
    return type(n) is int and 0 <= n <= U32_MAX


def fee_invariants(fees, height, grace=None):
    # `grace` bounds how long `previous` stays; without the rules it cannot be checked.
    def ok(v):
        need(v, 'fee state invariant')
    grids = [g for g in (fees['current'], fees['previous'], fees['pending']) if g is not None]
    ok(_u32(fees['nextGrid']) and type(fees['nextReset']) is int and 0 <= fees['nextReset'] <= MAX_RESETS)
    ok(all(_u32(g['id']) and check_rate(g['rate']) and _u32(g['effective']) and _u32(g['height'])
           and _u32(g['index']) and g['id'] < fees['nextGrid'] for g in grids))
    ok(fees['pending'] is None or fees['pending']['effective'] > height)
    ok(fees['previous'] is None or grace is None or height < fees['current']['effective'] + grace)
    roles = [fees['operator'], fees['guardian'], fees['sentinel']]
    for p in (fees['pendingOperator'], fees['pendingGuardian']):
        if p is not None:
            ok(_u32(p['effective']))
            roles.append(p['account'])
    ok(fees['guardian'] is not None and fees['sentinel'] is not None)
    roles = [x for x in roles if x is not None]
    ok(all(isinstance(x, str) and ID.fullmatch(x) for x in roles))
    ok(len(set(roles)) == len(roles) and ZERO not in roles and FEE_ACCOUNT not in roles)


def snapshot_fees(fees):
    # The format-2 snapshot member: the rate as a decimal string, null for empty slots.
    if fees is None:
        return None
    out = copy.deepcopy(fees)
    for key in ('current', 'previous', 'pending'):
        if out[key] is not None:
            out[key]['rate'] = str(out[key]['rate'])
    return out
