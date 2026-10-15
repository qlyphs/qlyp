// A copy of the reader with the two mainnet pins replaced: set to another activation for tests of
// the cutover, or both null for the reading mainnet had before the activation release.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const V2_PIN = /export const MAINNET_PROGRESSIVE_V2_FROM: number \| null = [^;]+;/g;
const FEES_PIN = /export const MAINNET_FEE_SCHEDULE: FeeRules \| null = (?:null|\{[\s\S]*?\n\});/g;

/** The protocol source with both pins replaced by `fees.from` and `fees`, or both null when `fees`
 * is null. Each pin must appear exactly once, so a renamed pin fails here instead of leaving the
 * copy with the release's own pins. */
export function activatedSource(source, fees) {
  for (const pin of [V2_PIN, FEES_PIN])
    if ((source.match(pin) ?? []).length !== 1) throw Error(`pin not found exactly once: ${pin}`);
  return source
    .replace(V2_PIN, `export const MAINNET_PROGRESSIVE_V2_FROM: number | null = ${fees === null ? null : fees.from};`)
    .replace(FEES_PIN, `export const MAINNET_FEE_SCHEDULE: FeeRules | null = ${JSON.stringify(fees)};`);
}

/** Imports src/index.ts and test/helpers/fee-harness.mjs from a temporary copy whose pins are
 * `fees` (null: no activation). Call `close` when done. */
export async function activatedMainnet(fees) {
  const dir = mkdtempSync(join(tmpdir(), 'qlyp-activated-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'test/helpers'), join(dir, 'test/helpers'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const protocol = join(dir, 'src/protocol.ts');
  writeFileSync(protocol, activatedSource(readFileSync(protocol, 'utf8'), fees));
  const lib = await import(pathToFileURL(join(dir, 'src/index.ts')).href);
  const harness = await import(pathToFileURL(join(dir, 'test/helpers/fee-harness.mjs')).href);
  return { lib, harness, close: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The reader as mainnet ran it before the activation release: both pins null. */
export const unactivatedMainnet = () => activatedMainnet(null);
