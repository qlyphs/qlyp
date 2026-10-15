// Shared payer balance check used by both wallets (extension and native web wallet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUY_FUNDS_ERROR, FEE_FUNDS_ERROR, SEND_FUNDS_ERROR, SEND_LOCKED_ERROR, checkPayerBalance, nativeOutlay } from '../src/balance.ts';
import { LEGACY_DEPLOY_FEE as DEPLOY_FEE, MINT_FEE, QLYPHS_FEE_ACCOUNT, qlyphsFee, saleFee } from '../src/index.ts';

const id = n => '0x' + n.toString(16).padStart(64, '0');
const deploy = { kind: 'deploy', symbol: 'TEST', decimals: 6, cap: 1000n, limit: 500n, policy: 'issuer' };
const mint = { kind: 'mint', asset: '0x' + '11'.repeat(40), amount: 1n };
const costs = (command, ticket) => ({ networkFee: '10', nativeFee: '0', deposit: '0', existentialDeposit: '5', platformFee: qlyphsFee(command, ticket, { legacy: true }).toString() });
const funds = free => ({ free: free.toString(), frozen: '0' });

test('deploy and mint need the Qlyphs fee on top of network fee and existential deposit', () => {
  for (const [command, fee] of [[deploy, DEPLOY_FEE], [mint, MINT_FEE]]) {
    const need = fee + 10n + 5n;
    checkPayerBalance(funds(need), costs(command), command);
    assert.throws(() => checkPayerBalance(funds(need - 1n), costs(command), command), { message: FEE_FUNDS_ERROR });
    assert.match(FEE_FUNDS_ERROR, /Qlyphs fee/);
  }
});
test('buy needs price + 1% sale fee; sendQtc its amount; unconfirmed funds are reported as locked', () => {
  const price = 1_000_000n, ticket = { offer: { price, fee: saleFee(price), feeTo: QLYPHS_FEE_ACCOUNT } };
  const buy = { kind: 'buy', ticket: id(9) }, need = price + saleFee(price) + 15n;
  checkPayerBalance(funds(need), costs(buy, ticket), buy, ticket);
  assert.throws(() => checkPayerBalance(funds(need - 1n), costs(buy, ticket), buy, ticket), { message: BUY_FUNDS_ERROR });
  const send = { kind: 'sendQtc', to: id(2), amount: 100n };
  assert.throws(() => checkPayerBalance(funds(114n), costs(send), send), { message: SEND_FUNDS_ERROR });
  const pending = { free: '1000', frozen: '0', finalized: { free: '0', frozen: '0' } };
  assert.throws(() => checkPayerBalance(pending, costs(send), send), { message: SEND_LOCKED_ERROR });
  assert.equal(nativeOutlay({ kind: 'pair', counterparty: id(2) }), undefined);
});
