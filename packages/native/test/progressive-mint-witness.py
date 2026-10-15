"""Tests and bounded differential probe for the independent pricing module."""
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'apps/native/verifier'))
from progressive_mint import (PROFILE, PROFILE_V2, LOT_COUNT, TOTAL_FEE, TOTAL_FEE_V2,
                              mint_ticket, progressive_mint_quote, require_progressive_mint)

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/progressive-mint.json').read_text())


class ProgressiveMintTests(unittest.TestCase):
    def test_profile(self):
        self.assertEqual(PROFILE, FIXTURE['profile'])
        self.assertEqual(LOT_COUNT, int(FIXTURE['lots']))
        self.assertEqual(TOTAL_FEE, int(FIXTURE['totalFee']))

    def test_v2_profile(self):
        # progressive-1000-v2: 0.01, 0.10, 0.20, 0.30 and 0.44 QTC per 200-lot tier, 210 QTC in all.
        self.assertEqual(PROFILE_V2, 'progressive-1000-v2')
        self.assertEqual(TOTAL_FEE_V2, 210_000_000_000_000)
        tiers = (10_000_000_000, 100_000_000_000, 200_000_000_000, 300_000_000_000, 440_000_000_000)
        for cap in (1000, 21_000_000_000_000, (2**128 - 1) // 1000 * 1000):
            size, total = cap // 1000, 0
            for count in range(1000):
                quote = progressive_mint_quote(cap, count*size, PROFILE_V2)
                self.assertEqual(quote['profile'], PROFILE_V2)
                self.assertEqual(quote['nextFee'], tiers[count // 200])
                total += require_progressive_mint(cap, count*size, size, PROFILE_V2)['fee']
            self.assertEqual(total, TOTAL_FEE_V2)
            self.assertIsNone(progressive_mint_quote(cap, cap, PROFILE_V2)['nextFee'])
        with self.assertRaises(ValueError):
            progressive_mint_quote(1000, 0, 'progressive-1000-v3')

    def test_rights_are_separated_by_profile(self):
        genesis, asset, anchor = bytes(32), bytes(range(40)), bytes([7]) * 32
        v1 = mint_ticket(genesis, asset, 0, anchor, 3)
        v2 = mint_ticket(genesis, asset, 0, anchor, 3, PROFILE_V2)
        self.assertEqual(v1[1], v2[1])
        self.assertNotEqual(v1[0], v2[0])

    def test_all_lots_for_every_supply(self):
        for supply in FIXTURE['supplies']:
            cap, size = int(supply['cap']), int(supply['lotSize'])
            total = 0
            for tier in FIXTURE['tiers']:
                for count in range(int(tier['first']), int(tier['last'])+1):
                    quote = progressive_mint_quote(cap, count*size)
                    self.assertEqual(quote, dict(profile=PROFILE, lotSize=size,
                                     mintedLots=count, remainingLots=1000-count,
                                     nextFee=int(tier['fee'])))
                    mint = require_progressive_mint(cap, count*size, size)
                    self.assertEqual(mint['lot'], count+1)
                    self.assertEqual(mint['amount'], size)
                    self.assertEqual(mint['fee'], int(tier['fee']))
                    total += mint['fee']
            self.assertEqual(total, TOTAL_FEE)
            self.assertIsNone(progressive_mint_quote(cap, cap)['nextFee'])

    def test_cumulative_vectors(self):
        for expected in FIXTURE['cumulative']:
            count = int(expected['mintedLots'])
            total = sum(progressive_mint_quote(1000, i)['nextFee'] for i in range(count))
            self.assertEqual(total, int(expected['fee']))

    def test_invalid_quote_vectors(self):
        for v in FIXTURE['invalidQuotes']:
            with self.subTest(v=v), self.assertRaisesRegex(ValueError, '^'+v['error']+'$'):
                progressive_mint_quote(int(v['cap']), int(v['minted']))

    def test_types_are_not_coerced(self):
        for invalid in (True, False, 1000.0, '1000', None, [], {}):
            with self.subTest(value=invalid), self.assertRaisesRegex(ValueError, '^invalid supply$'):
                progressive_mint_quote(invalid, 0)
            with self.subTest(value=invalid), self.assertRaisesRegex(ValueError, '^invalid minted amount$'):
                progressive_mint_quote(1000000, invalid)
            with self.subTest(value=invalid), self.assertRaisesRegex(ValueError, '^invalid mint amount$'):
                require_progressive_mint(1000000, 0, invalid)

    def test_exact_amount(self):
        for amount in (1, 500, 999, 1001, 2000, 2**128):
            with self.subTest(amount=amount), self.assertRaisesRegex(ValueError, '^mint amount must equal one lot$'):
                require_progressive_mint(1000000, 0, amount)
        for amount in (0, -1):
            with self.assertRaisesRegex(ValueError, '^invalid mint amount$'):
                require_progressive_mint(1000000, 0, amount)

    def test_exhaustion_has_no_free_mint(self):
        self.assertEqual(progressive_mint_quote(1000, 1000)['remainingLots'], 0)
        with self.assertRaisesRegex(ValueError, '^mint sold out$'):
            require_progressive_mint(1000, 1000, 1)

    def test_no_reservation_side_effect(self):
        first = progressive_mint_quote(1000000, 199000)
        second = progressive_mint_quote(1000000, 199000)
        self.assertEqual(first, second)
        self.assertEqual(first['nextFee'], 100000000000)
        self.assertEqual(progressive_mint_quote(1000000, 200000)['nextFee'], 200000000000)


def probe():
    """Test-only JSON interface; production replay does not import this file."""
    raw = sys.stdin.buffer.read(2*1024*1024+1)
    if len(raw) > 2*1024*1024:
        raise ValueError('probe input too large')
    records = json.loads(raw)
    if not isinstance(records, list) or len(records) > 10000:
        raise ValueError('invalid probe cases')

    def integer(value):
        if not isinstance(value, str) or not re.fullmatch(r'(?:0|-?[1-9][0-9]{0,38})', value):
            raise ValueError('noncanonical test amount')
        return int(value)

    results = []
    for record in records:
        try:
            keys = set(record) - {'profile'} if isinstance(record, dict) else None
            if keys not in ({'cap', 'minted'}, {'cap', 'minted', 'amount'}):
                raise ValueError('invalid probe record')
            cap, minted = integer(record['cap']), integer(record['minted'])
            profile = record.get('profile', PROFILE)
            if 'amount' in record:
                result = require_progressive_mint(cap, minted, integer(record['amount']), profile)
            else:
                result = progressive_mint_quote(cap, minted, profile)
            results.append({k: str(v) if type(v) is int else v for k, v in result.items()})
        except ValueError as error:
            results.append({'error': str(error)})
    json.dump(results, sys.stdout, separators=(',', ':'))


if __name__ == '__main__':
    if sys.argv[1:] == ['--probe']:
        probe()
    else:
        unittest.main()
