#!/usr/bin/env node
// Agent-level evaluation: does a cheap, fast model actually use this skill well?
//
// Protocol is plain text, not function calling. The model writes a fenced
// command block; this runner executes it and feeds the output back. Two reasons:
// many free and cheap OpenRouter models have weak or absent tool-calling, and a
// text protocol tests whether SKILL.md is clear on its own terms rather than
// whether a schema was filled in.
//
// Scoring is deterministic. The important check is `numbers_traceable`: every
// number in the model's final answer must appear in the command output it was
// shown. That is the anti-hallucination test, and it cannot be gamed by prose.
//
// Usage:
//   OPENROUTER_API_KEY=... node evals/run.mjs --model <id> [--scenarios f] [--only id]
//   node evals/run.mjs --dry-run          # validate scenarios, no API key needed

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { ALLOWED, extractCommands, toArgv, compile, score } from './lib.mjs';

const execFileP = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SKILL_DIR = path.join(HERE, '..');
const MAX_STEPS = 6;

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'meta-llama/llama-3.3-70b-instruct:free' },
    scenarios: { type: 'string', default: path.join(HERE, 'scenarios.jsonl') },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(HERE, 'results') },
  },
  strict: true,
});

async function runCommand(cmd) {
  if (!ALLOWED.test(cmd)) return { ok: false, output: `refused: only "node scripts/wt.mjs ..." may be run` };
  // Split respecting quotes, so topics with spaces survive.
  const argv = toArgv(cmd);
  try {
    const { stdout } = await execFileP(argv[0], argv.slice(1), {
      cwd: SKILL_DIR,
      timeout: 120_000,
      maxBuffer: 8 << 20,
      env: process.env,
    });
    return { ok: true, output: stdout.slice(0, 20_000) };
  } catch (e) {
    return { ok: false, output: ((e.stdout ?? '') + (e.stderr ?? e.message)).slice(0, 4000) };
  }
}

async function chat(messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'wiki-interest-trends-eval',
    },
    body: JSON.stringify({ model: values.model, messages, temperature: 0, max_tokens: 1200 }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  if (j.error) throw new Error(`OpenRouter: ${j.error.message ?? JSON.stringify(j.error)}`);
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? {} };
}

async function runScenario(sc, systemPrompt) {
  const messages = [
    {
      role: 'system',
      content:
        `${systemPrompt}\n\n---\n\nYou are working in the skill directory. To run a command, ` +
        `write it in a bash code block. You will be shown its output and may then run another. ` +
        `When you have enough information, reply with your final answer and NO code block.`,
    },
    { role: 'user', content: sc.prompt },
  ];

  const commands = [];
  let toolOutput = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let answer = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const { text, usage: u } = await chat(messages);
    usage.prompt_tokens += u.prompt_tokens ?? 0;
    usage.completion_tokens += u.completion_tokens ?? 0;
    messages.push({ role: 'assistant', content: text });

    const cmds = extractCommands(text);
    if (!cmds.length) {
      answer = text;
      break;
    }
    let block = '';
    for (const c of cmds) {
      const r = await runCommand(c);
      commands.push(c);
      block += `$ ${c}\n${r.output}\n`;
    }
    toolOutput += block;
    messages.push({ role: 'user', content: block.slice(0, 20_000) });
    answer = text;
  }

  const scored = score(sc, { commands, answer, toolOutput });
  return {
    id: sc.id,
    ...scored,
    commands,
    steps: commands.length,
    tokens: usage,
    answer: answer.slice(0, 1500),
  };
}

// ---- main

const raw = await readFile(values.scenarios, 'utf8');
let scenarios = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (values.only) scenarios = scenarios.filter((s) => s.id === values.only);

if (values['dry-run']) {
  console.log(`${scenarios.length} scenarios parsed`);
  for (const s of scenarios) {
    for (const key of ['must_call', 'must_mention', 'must_not_mention'])
      for (const p of s[key] ?? []) compile(p); // throws on a bad pattern
    console.log(`  ok  ${s.id.padEnd(26)} ${(s.must_call ?? []).length} call checks, ${(s.must_mention ?? []).length} content checks`);
  }
  console.log('\nAll patterns compile. Set OPENROUTER_API_KEY and drop --dry-run to evaluate.');
  process.exit(0);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Use --dry-run to validate scenarios without it.');
  process.exit(2);
}
if (!process.env.WT_CONTACT) {
  console.error('WT_CONTACT is not set; the skill will fail with 403.');
  process.exit(2);
}

const systemPrompt = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const results = [];
for (const sc of scenarios) {
  process.stderr.write(`running ${sc.id} ... `);
  try {
    const r = await runScenario(sc, systemPrompt);
    results.push(r);
    process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} (${r.steps} cmds, ${r.tokens.prompt_tokens + r.tokens.completion_tokens} tok)\n`);
  } catch (e) {
    results.push({ id: sc.id, pass: false, error: e.message });
    process.stderr.write(`ERROR ${e.message}\n`);
  }
}

const passed = results.filter((r) => r.pass).length;
const totalTokens = results.reduce((a, r) => a + (r.tokens ? r.tokens.prompt_tokens + r.tokens.completion_tokens : 0), 0);

console.log(`\nmodel: ${values.model}`);
console.log(`passed: ${passed}/${results.length}`);
console.log(`tokens: ${totalTokens} total, ${Math.round(totalTokens / Math.max(1, results.length))} avg per scenario\n`);
for (const r of results) {
  const failed = Object.entries(r.checks ?? {}).filter(([, v]) => !v).map(([k]) => k);
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}${failed.length ? '  [' + failed.join(', ') + ']' : ''}${r.error ? '  ' + r.error : ''}`);
  if (r.invented_numbers?.length) console.log(`        invented numbers: ${r.invented_numbers.join(', ')}`);
  if (r.missed_calls?.length) console.log(`        never ran: ${r.missed_calls.join(' | ')}`);
  if (r.missed_mentions?.length) console.log(`        never said: ${r.missed_mentions.join(' | ')}`);
}

await mkdir(values.out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(values.out, `${values.model.replace(/[^\w.-]/g, '_')}_${stamp}.json`);
await writeFile(file, JSON.stringify({ model: values.model, passed, total: results.length, totalTokens, results }, null, 2));
console.log(`\ntranscripts: ${file}`);
process.exit(passed === results.length ? 0 : 1);
