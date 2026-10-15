// Fee schedule fixtures shared by the tests: public development role ids and rules builders.
import { createHash } from 'node:crypto';

/** A public, deterministic development account id for a fee role label. Never a mainnet key. */
export const devAccount = (label) =>
  '0x' + createHash('sha512').update('Qlyphs/QLYP/fee-dev/' + label).digest('hex').slice(0, 64);
export const OPERATOR = devAccount('operator');
export const GUARDIAN = devAccount('guardian');
export const SENTINEL = devAccount('sentinel');
/** Development windows (delay 600, grace 384) and a 1e10 rate (QTC = 100 USD). */
export const feeRules = (over = {}) => ({
  from: 10,
  operator: OPERATOR,
  guardian: GUARDIAN,
  sentinel: SENTINEL,
  rate: '10000000000',
  delay: 600,
  grace: 384,
  guardianDelay: 600,
  legacyBefore: true,
  resets: [],
  ...over,
});
/** The mainnet windows of the activation, with the legacy fees kept below `from` and for `grace`
 * blocks after it. */
export const mainnetFeeRules = (from, over = {}) =>
  feeRules({ from, delay: 7200, grace: 4608, guardianDelay: 50400, legacyBefore: true, ...over });
export const rulesWith = (feeSchedule, over = {}) => ({ progressive: null, progressiveV2: null, feeSchedule, ...over });
