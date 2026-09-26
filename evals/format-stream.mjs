#!/usr/bin/env node
// Turn `claude -p --output-format stream-json` into a readable transcript.
//
// The raw stream is one JSON object per line, most of it protocol bookkeeping.
// What matters when evaluating a skill is the sequence: which commands the model
// chose, what came back, and what it finally said.
//
// Usage:
//   claude -p "..." --output-format stream-json --verbose | node evals/format-stream.mjs
//   node evals/format-stream.mjs run.jsonl
//   node evals/format-stream.mjs run.jsonl --full     # don't truncate tool output

import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const args = process.argv.slice(2);
const full = args.includes('--full');
const file = args.find((a) => !a.startsWith('--'));

const C = process.stdout.isTTY
  ? { dim: '[2m', cmd: '[36m', out: '[32m', txt: '[0m', warn: '[33m', off: '[0m' }
  : { dim: '', cmd: '', out: '', txt: '', warn: '', off: '' };

const clip = (s, n) => {
  const t = String(s).trimEnd();
  if (full || t.length <= n) return t;
  const shown = t.slice(0, n);
  return `${shown}\n${C.dim}     ... ${t.length - n} more characters (use --full)${C.off}`;
};

const indent = (s, pad = '     ') => String(s).split('\n').map((l) => pad + l).join('\n');

const input = file ? createReadStream(file) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });

let turn = 0;
let cmds = 0;

for await (const line of rl) {
  if (!line.trim()) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }

  if (e.type === 'assistant') {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'tool_use') {
        cmds += 1;
        const input_ = b.input ?? {};
        const shown = input_.command ?? JSON.stringify(input_);
        console.log(`\n${C.cmd}[${++turn}] ${b.name}${C.off}  ${C.cmd}$ ${shown}${C.off}`);
      } else if (b.type === 'text' && b.text?.trim()) {
        console.log(`\n${C.txt}${indent(b.text.trim(), '  ')}${C.off}`);
      }
    }
  } else if (e.type === 'user') {
    for (const b of e.message?.content ?? []) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      const text = typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('\n');
      const colour = b.is_error ? C.warn : C.out;
      console.log(`${colour}${indent(clip(text, 900))}${C.off}`);
    }
  } else if (e.type === 'result') {
    console.log(
      `\n${C.dim}--- ${e.is_error ? 'ERROR' : 'done'} | ${cmds} command(s) | ` +
        `$${(e.total_cost_usd ?? 0).toFixed(4)} | ${((e.duration_ms ?? 0) / 1000).toFixed(1)}s${C.off}`,
    );
  }
}
