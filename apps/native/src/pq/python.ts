import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { requireThat } from '../../../../packages/native/src/codec.ts';
import { TICKERS_DIGEST } from '../../../../packages/native/src/tickers.ts';
import { json } from '../commands.ts';
import { MAX_PROOF_BYTES } from './checkpoint.ts';
import type { Snapshot } from './checkpoint.ts';

export class PythonReducer {
  private child;
  private pending: {
    resolve: (s: Snapshot) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private dead = false;
  constructor(script = resolve('verifier/replay.py')) {
    this.child = spawn('python3', ['-I', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0;
    this.child.stdout.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_PROOF_BYTES) this.fail();
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      bytes = 0;
      const p = this.pending;
      this.pending = null;
      if (!p) {
        this.fail();
        return;
      }
      clearTimeout(p.timer);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        p.reject(new Error('invalid verifier output'));
        this.fail();
        return;
      }
      // Only a tip is refused on its own; the verifier keeps its finalized ledger and serves on.
      if (value && typeof value === 'object' && 'error' in value)
        p.reject(new Error('independent verifier refused the tip'));
      else p.resolve(value as Snapshot);
    });
    // No raw receipts, user input or secret material is echoed to logs.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
  }
  private fail() {
    this.dead = true;
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error('independent verifier stopped'));
    }
    this.child.kill();
  }
  request(value: unknown): Promise<Snapshot> {
    requireThat(!this.pending && !this.dead, 'verifier unavailable/concurrent request');
    // The verifier refuses to start unless its blocked tickers hash to ours. A caller may still pass
    // its own digest, which is how a test checks the refusal.
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { kind?: unknown }).kind === 'init' &&
      !('tickersDigest' in value)
    )
      value = { ...value, tickersDigest: TICKERS_DIGEST };
    const line = json(value) + '\n';
    requireThat(Buffer.byteLength(line) <= MAX_PROOF_BYTES, 'verifier input too large');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 30000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(line, (error) => {
        if (error) this.fail();
      });
    });
  }
  close() {
    this.fail();
  }
}
