/**
 * Real-world scenario runner for Project Mimi.
 * Drives the real agent loop (core.runTurn) with a scripted permission broker and
 * records a full transcript + final output for each scenario.
 *
 * Usage: node test-harness/runner.ts test-harness/scenarios/01-summary.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentEvent, PermissionRequest } from '@mimi/shared';
import type { PermissionBroker } from '../packages/core/src/permissions/gate.ts';
import { loadConfig } from '../packages/core/src/config.ts';
import { createCore } from '../packages/core/src/core.ts';

interface Scenario {
  id: string;
  title: string;
  description: string;
  agent: string;
  /** Per-tool auto decisions. */
  permissions?: {
    default?: 'allow' | 'deny';
    allow?: string[];
    deny?: string[];
    /** For run_shell: allow when the summarized command matches one of these (case-insensitive substring). */
    shellAllow?: string[];
    shellDeny?: string[];
  };
  /** User turns; later turns happen after the previous one finished. */
  turns: Array<{ text: string }>;
  /** After the last turn: fire the newest reminder trigger and record the notification. */
  fireReminder?: boolean;
  /** Total run budget in ms. */
  timeoutMs?: number;
}

function summaryText(request: PermissionRequest): string {
  return request.summary ?? `${request.tool}`;
}

class ScriptedBroker implements PermissionBroker {
  private readonly scenario: Scenario;
  private readonly log: (line: string) => void;
  decisions = 0;

  constructor(scenario: Scenario, log: (line: string) => void) {
    this.scenario = scenario;
    this.log = log;
  }

  async request(request: PermissionRequest): Promise<boolean> {
    this.decisions += 1;
    const perms = this.scenario.permissions ?? {};
    const summary = summaryText(request);
    let allowed: boolean;
    let why = 'default';
    if (perms.allow?.includes(request.tool)) {
      allowed = true;
      why = 'allow-list';
    } else if (perms.deny?.includes(request.tool)) {
      allowed = false;
      why = 'deny-list';
    } else if (request.tool === 'run_shell') {
      const text = summary.toLowerCase();
      const ok = (perms.shellAllow ?? []).some((p) => text.includes(p.toLowerCase()));
      const bad = (perms.shellDeny ?? []).some((p) => text.includes(p.toLowerCase()));
      allowed = ok && !bad;
      why = `shell-pattern ${allowed ? 'allow' : 'deny'}`;
    } else {
      allowed = (perms.default ?? 'deny') === 'allow';
      why = `default-${perms.default ?? 'deny'}`;
    }
    this.log(`  [PERMISSION] ${request.tool} (${request.risk}) -> ${allowed ? 'ALLOW' : 'DENY'} [${why}]\n    ${summary}`);
    return allowed;
  }
}

function preview(value: unknown, limit = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

class Transcript {
  lines: string[] = [];
  open = '';
  write(line = ''): void {
    if (this.open) {
      this.lines.push(this.open);
      this.open = '';
    }
    this.lines.push(line);
  }
  append(text: string): void {
    this.open += text;
  }
  save(file: string): void {
    if (this.open) this.lines.push(this.open);
    fs.writeFileSync(file, `${this.lines.join('\n')}\n`, 'utf8');
  }
}

function renderEvent(t: Transcript, event: AgentEvent, depth: number, isSub: boolean): void {
  const pad = depth > 0 ? '    '.repeat(depth) : '';
  const tag = depth > 0 ? `    [${event.agent ?? 'sub'}]` : '';
  switch (event.type) {
    case 'run-start':
      t.write(`${pad}== run-start agent=${event.agent} model=${event.model}`);
      break;
    case 'text-delta':
      t.append(event.text);
      break;
    case 'tool-call':
      t.write(`${pad}  [tool] ${event.call.name} ${preview(event.call.input)}`);
      break;
    case 'tool-result':
      t.write(`${pad}  [${event.result.ok ? 'ok' : 'failed'}] ${preview(event.result.output)}`);
      break;
    case 'permission-decision':
      if (!event.decision.allow) t.write(`${pad}  [permission denied: ${event.decision.reason}]`);
      break;
    case 'attachment':
      t.write(`${pad}  [file] ${event.attachment.name} (${event.attachment.kind})`);
      break;
    case 'agent-activity':
      renderEvent(t, event.event, depth + 1, true);
      break;
    case 'run-finish': {
      const u = event.usage;
      if (isSub) {
        t.write(`${pad}${tag} done (${event.reason}, ${event.rounds} rounds, $${u.costUsd.toFixed(5)})`);
      } else {
        t.write(
          `${pad}== run-finish reason=${event.reason} rounds=${event.rounds} in=${u.inputTokens} out=${u.outputTokens} cache=${u.cachedTokens} cost=$${u.costUsd.toFixed(5)}`,
        );
        if (event.error) t.write(`${pad}== error: ${event.error}`);
      }
      break;
    }
    default:
      break;
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { debug: { type: 'boolean' } } });
  if (values.debug) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('opencode.ai')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        console.error(`[DEBUG FETCH] ${init?.method ?? 'GET'} ${url}`);
        if (body) console.error(`[DEBUG FETCH] body keys: ${Object.keys(body).join(', ')}`);
        const res = await realFetch(input, init);
        if (!res.ok) {
          const text = await res.clone().text();
          console.error(`[DEBUG FETCH] status ${res.status}: ${text.slice(0, 400)}`);
        } else {
          console.error(`[DEBUG FETCH] status ${res.status}`);
        }
        return res;
      }
      return realFetch(input, init);
    };
  }
  const scenarioPath = positionals[0];
  if (!scenarioPath) throw new Error('usage: node test-harness/runner.ts <scenario.json>');
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario;

  const outDir = path.join('test-report', scenario.id);
  fs.mkdirSync(outDir, { recursive: true });
  const t = new Transcript();
  const save = () => {
    t.save(path.join(outDir, 'transcript.txt'));
    fs.writeFileSync(path.join(outDir, 'input.json'), `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  };

  const config = loadConfig();
  const broker = new ScriptedBroker(scenario, (line) => t.write(line));
  const core = await createCore(config, broker);

  const notices: string[] = [];
  core.listeners.notification = (n) => {
    const line = `  [NOTIFY] ${n.kind}: ${n.title} — ${n.body}`;
    notices.push(line);
    t.write(line);
  };

  const agentDef = core.agents.get(scenario.agent);
  const runId = Date.now();

  const started = Date.now();
  const budget = scenario.timeoutMs ?? 600_000;
  let failed = false;
  try {
    for (const [index, turn] of scenario.turns.entries()) {
      t.write(`\n########## TURN ${index + 1} ##########`);
      t.write(`user> ${turn.text}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget - (Date.now() - started));
      let finalText = '';
      try {
        for await (const event of core.runTurn({ agent: agentDef, userText: turn.text, thread: `test:${scenario.id}:${runId}`, signal: controller.signal })) {
          if (event.type === 'run-finish') finalText = event.text;
          renderEvent(t, event, 0, false);
        }
      } catch (error) {
        t.write(`== ERROR: ${(error as Error).message}`);
        failed = true;
      } finally {
        clearTimeout(timer);
      }
      if (finalText.trim()) {
        fs.writeFileSync(path.join(outDir, 'final-output.txt'), finalText.trim(), 'utf8');
      }
    }

    if (scenario.fireReminder) {
      t.write('\n########## REMINDER FIRE CHECK ##########');
      const active = core.triggers.list('active');
      if (active.length > 0) {
        const newest = active[active.length - 1];
        t.write(`firing reminder #${newest.id} "${newest.title}"`);
        const result = await core.fire(newest.id);
        t.write(`fire result: ${result}`);
      } else {
        t.write('no active reminders to fire');
      }
      await new Promise((r) => setTimeout(r, 4000));
      for (const line of core.jobs.drainNotices()) t.write(`  [job] ${line}`);
    }

    await new Promise((r) => setTimeout(r, 4000));
    for (const line of core.jobs.drainNotices()) t.write(`  [job] ${line}`);
  } finally {
    t.write(`\n== permissions asked: ${broker.decisions}, wall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    save();
    await core.close().catch(() => {});
  }
  console.log(`[${scenario.id}] ${failed ? 'FAILED' : 'done'} -> test-report/${scenario.id}/ (${(Date.now() - started) / 1000}s)`);
}

await main();
