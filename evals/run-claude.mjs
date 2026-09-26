#!/usr/bin/env node
// Agent-level evaluation driven by the Claude Code CLI.
//
// Same scenarios and same scoring as run.mjs, but the model is reached through
// `claude -p` instead of OpenRouter. Two advantages: no extra API key, and
// Haiku 4.5 is precisely the class of fast, cheap model the skill is supposed
// to work on.
//
// By default SKILL.md is appended to the system prompt, which tests whether the
// document alone is enough to drive correct behaviour. Pass --installed to test
// the real path instead, where the skill must first be discovered by name.
//
// Usage:
//   WT_CONTACT=you@example.com node evals/run-claude.mjs
//   node evals/run-claude.mjs --model haiku --only brief-1-fasting
//   node evals/run-claude.mjs --dry-run      # print the commands, call nothing

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { ALLOWED, score } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SKILL_DIR = path.join(HERE, '..');

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'haiku' },
    scenarios: { type: 'string', default: path.join(HERE, 'scenarios.jsonl') },
    only: { type: 'string' },
    installed: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(HERE, 'results') },
  },
  strict: true,
});

/** Run one prompt through `claude -p`, capturing tool calls, answer and cost. */
function runClaude(prompt, systemPrompt) {
  const args = [
    '-p', prompt,
    '--model', values.model,
    '--allowedTools', 'Bash',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: SKILL_DIR, env: process.env });
    let buf = '';
    const commands = [];
    const outputs = [];
    let answer = '';
    let cost = 0;
    let turns = 0;

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }

        if (e.type === 'assistant') {
          turns += 1;
          for (const b of e.message?.content ?? []) {
            if (b.type === 'tool_use' && b.name === 'Bash' && b.input?.command) commands.push(b.input.command);
            else if (b.type === 'text' && b.text?.trim()) answer = b.text; // last text block wins
          }
        } else if (e.type === 'user') {
          // Tool results come back as user messages; collect them so figures in
          // the answer can be traced to something the model was actually shown.
          for (const b of e.message?.content ?? []) {
            if (b.type === 'tool_result') {
              const c = b.content;
              outputs.push(typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('\n'));
            }
          }
        } else if (e.type === 'result') {
          cost = e.total_cost_usd ?? 0;
          if (!answer && e.result) answer = String(e.result);
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !commands.length && !answer) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      resolve({ commands, answer, toolOutput: outputs.join('\n'), cost, turns });
    });
  });
}

const scenariosRaw = await readFile(values.scenarios, 'utf8');
let scenarios = scenariosRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (values.only) scenarios = scenarios.filter((s) => s.id === values.only);

if (!process.env.WT_CONTACT) {
  console.error('WT_CONTACT is not set; every skill command would fail with 403.');
  process.exit(2);
}

const systemPrompt = values.installed ? null : await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

if (values['dry-run']) {
  console.log(`${scenarios.length} scenarios, model ${values.model}, ${values.installed ? 'installed skill' : 'SKILL.md in system prompt'}`);
  for (const s of scenarios) console.log(`  ${s.id.padEnd(26)} ${s.prompt.slice(0, 80)}`);
  console.log('\nDrop --dry-run to run them. Each scenario costs roughly $0.02-0.10 on haiku.');
  process.exit(0);
}

const results = [];
let totalCost = 0;

for (const sc of scenarios) {
  process.stderr.write(`running ${sc.id} ... `);
  try {
    const t = await runClaude(sc.prompt, systemPrompt);
    totalCost += t.cost;
    const scored = score(sc, t);
    const refused = t.commands.filter((c) => !ALLOWED.test(c));
    results.push({ id: sc.id, ...scored, commands: t.commands, off_skill_commands: refused, cost: t.cost, turns: t.turns, answer: t.answer.slice(0, 1200) });
    process.stderr.write(`${scored.pass ? 'PASS' : 'FAIL'} (${t.commands.length} cmds, $${t.cost.toFixed(4)})\n`);
  } catch (e) {
    results.push({ id: sc.id, pass: false, error: e.message });
    process.stderr.write(`ERROR ${e.message}\n`);
  }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nmodel: ${values.model}   passed: ${passed}/${results.length}   cost: $${totalCost.toFixed(4)}\n`);
for (const r of results) {
  const failed = Object.entries(r.checks ?? {}).filter(([, v]) => !v).map(([k]) => k);
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}${failed.length ? '  [' + failed.join(', ') + ']' : ''}${r.error ? '  ' + r.error : ''}`);
  if (r.sentence_topics?.length) console.log(`        passed a sentence as the topic: ${JSON.stringify(r.sentence_topics)}`);
  if (r.invented_numbers?.length) console.log(`        numbers not in any output: ${r.invented_numbers.join(', ')}`);
  if (r.missed_calls?.length) console.log(`        never ran: ${r.missed_calls.join(' | ')}`);
  if (r.missed_mentions?.length) console.log(`        never said: ${r.missed_mentions.join(' | ')}`);
  if (r.off_skill_commands?.length) console.log(`        ran non-skill commands: ${r.off_skill_commands.join(' | ')}`);
}

await mkdir(values.out, { recursive: true });
const file = path.join(values.out, `claude-${values.model}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
await writeFile(file, JSON.stringify({ model: values.model, passed, total: results.length, totalCost, results }, null, 2));
console.log(`\ntranscripts: ${file}`);
process.exit(passed === results.length ? 0 : 1);
