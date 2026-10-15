/** Types of the test-only next-lot model. */
export interface Anchor {
  height: number;
  hash: string;
  index: number;
}
export interface ModelState {
  genesis: string;
  asset: string;
  cap: string;
  minted: string;
  feeTo: string;
  height: number;
  hash: string;
  anchor: Anchor | null;
  balances: Record<string, string>;
  sequences: Record<string, string>;
  collected: string;
}
export interface Right {
  asset: string;
  lot: string;
  amount: string;
  fee: string;
  feeTo: string;
  signers: string[];
  threshold: 2;
  nonce: string;
  anchor: Anchor;
}
export type ModelEvent =
  | { kind: 'created'; creator: string; signers: string[]; threshold: number; nonce: string }
  | { kind: 'paid'; from: string; to: string; amount: string }
  | { kind: 'completed' };
export interface ModelReceipt {
  index: number;
  signer: string | null;
  callHex: string;
  success: boolean;
  events: ModelEvent[];
}
export interface ModelBlock {
  height: number;
  hash: string;
  parent: string;
  receipts: ModelReceipt[];
}
export function fixtureState(input: {
  genesis: string;
  asset: string;
  cap: string;
  feeTo: string;
  anchor: Anchor;
  minted?: string;
  holder?: string;
}): ModelState;
export function assertState(s: ModelState): void;
export function nextRight(s: ModelState): Right | null;
export function creationHex(right: Right): string;
export function settlementHex(right: Right): string;
export function sameTicket(event: ModelEvent, right: Right): boolean;
export function applyBlock(state: ModelState, block: ModelBlock): ModelState;
