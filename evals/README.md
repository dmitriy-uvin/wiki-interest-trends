# Agent-level evaluation

The skill has to work for an agent on a cheap, fast model. These scenarios check
that, and they check it deterministically.

## Protocol

Plain text, not function calling. The model writes a command in a fenced block;
the runner executes it and feeds the output back. Two reasons:

- Many free and cheap OpenRouter models have weak or absent tool-calling, so a
  function-calling harness would measure the model's schema support rather than
  the skill.
- A text protocol tests whether `SKILL.md` is clear on its own terms.

Only `node scripts/wt.mjs ...` may be executed. Anything else is refused.

## Running

```bash
export WT_CONTACT="you@example.com"
export OPENROUTER_API_KEY="sk-or-..."

node evals/run.mjs --dry-run                       # validate scenarios, no key needed
node evals/run.mjs --model "<cheap-model-id>"      # full suite
node evals/run.mjs --model "<id>" --only brief-1-fasting
```

Transcripts and scores are written to `evals/results/`.

## What is scored

| Check | Meaning |
|---|---|
| `ran_a_command` | The model used the skill instead of answering from memory |
| `correct_commands` | The commands it ran match the scenario's expectations |
| `required_content` | The answer covers what it must (e.g. that Polish has no article) |
| `avoided_wrong_claims` | The answer avoids specific known-wrong statements |
| `numbers_traceable` | **Every figure in the answer appeared in command output** |
| `topic_extracted` | The model passed a topic, not the user's whole question, as the argument |

`numbers_traceable` is the important one. Prose can be persuasive; an invented
number is detectable. Comparison is numeric, not substring — substring matching
silently accepts fabrications, since "63" occurs inside "40630". Small integers,
years, and figures the model rounded for readability are ignored, so the check
flags invention rather than paraphrase.

It is not a harness-only check. The function lives in `scripts/lib/claims.mjs` and
ships as `wt check`, which also gates `--notes` on the PDF — so this harness scores
the same code a user gets, rather than a second implementation of it.

## Scenarios

| id | Tests |
|---|---|
| `brief-1-fasting` | Course brief example 1. Polish has no article; the gap must not be reported as zero interest. |
| `brief-2-astronomy` | Course brief example 2. Must quote normalized figures and state limitations. |
| `brief-3-language-learning` | Course brief example 3. Multi-language comparison plus a recommendation. |
| `gold-mining-es-cliff` | The −85% that is a level break, not a market collapse. Its cause is unverified — the logs are empty — so the answer must not call it a rename either. |
| `low-volume-uk` | 261 views in a year; the model must notice the volume is too low. |
| `german-fold` | The concept folds into a broader article. |
| `followup-add-language` | A refinement turn; must re-run rather than invent. |
| `pdf-report` | Two-step views → report; must not try to write a PDF itself. |

The harness's own logic is unit-tested in `tests/evals.test.mjs`, including a
check that no scenario would pass on an empty transcript.
