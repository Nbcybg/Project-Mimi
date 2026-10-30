import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import type { AgentEvent } from '@mimi/shared';
import { type AgentDefinition, listAgents } from '../agents/loader.ts';
import { AppSettings } from '../app/app-settings.ts';
import { loadConfig } from '../config.ts';
import { type Core, createCore } from '../core.ts';
import { describeCompaction } from '../memory/post-turn.ts';
import { CliBroker } from '../permissions/cli-broker.ts';
import { formatModelRef, parseModelRef } from '../providers/registry.ts';
import { formatMemoryEntry, formatMemoryList, formatModelList, MEMORY_NOTE } from './commands.ts';
import { LineReader } from './line-reader.ts';

const HELP = `Commands:
  /agent <name>            switch agent (same thread)
  /agents                  list agents
  /triggers                list active reminders and scheduled tasks
  /model <provider/model>  use another chat model for this session
  /models [provider]       list models of providers that have an API key
  /memory                  list memory files
  /memory show <path>      print a memory file
  /memory delete <path>    delete a memory file   (edit: npm run memory -- edit <path>)
  /compact                 summarize older messages now and refresh the memory snapshot
  /help                    show this help
  /exit                    quit`;

function preview(value: unknown, limit = 200): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value)) ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

/** Renders one agent run to the terminal. */
class Renderer {
  private agent = '';
  private midLine = false;

  private line(text: string): void {
    process.stdout.write(`${this.midLine ? '\n' : ''}${text}\n`);
    this.midLine = false;
  }

  /** Sub-agent work is shown as compact indented lines; its text is not streamed. */
  private activity(agent: string, event: AgentEvent): void {
    const tag = `    [${agent}]`;
    if (event.type === 'agent-activity') this.activity(event.agent, event.event);
    else if (event.type === 'tool-call') this.line(`${tag} tool ${event.call.name} ${preview(event.call.input, 120)}`);
    else if (event.type === 'tool-result' && !event.result.ok) this.line(`${tag} failed: ${preview(event.result.output, 120)}`);
    else if (event.type === 'permission-decision' && !event.decision.allow) this.line(`${tag} permission ${event.decision.reason}`);
    else if (event.type === 'run-finish') this.line(`${tag} done (${event.reason}, $${event.usage.costUsd.toFixed(5)})`);
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'run-start':
        this.agent = event.agent;
        break;
      case 'agent-activity':
        this.activity(event.agent, event.event);
        break;
      case 'text-delta':
        if (!this.midLine) process.stdout.write(`${this.agent}> `);
        process.stdout.write(event.text);
        this.midLine = true;
        break;
      case 'tool-call':
        this.line(`  [tool] ${event.call.name} ${preview(event.call.input)}`);
        break;
      case 'tool-result':
        this.line(`  [${event.result.ok ? 'ok' : 'failed'}] ${preview(event.result.output)}`);
        break;
      case 'attachment':
        this.line(`  [file] ${event.attachment.name} (${event.attachment.kind}, ${Math.ceil(event.attachment.size / 1024)} KB)`);
        break;
      case 'permission-decision':
        if (!event.decision.allow) this.line(`  [permission ${event.decision.reason}]`);
        break;
      case 'run-finish': {
        const { usage } = event;
        const hitRate = usage.inputTokens > 0 ? Math.round((usage.cachedTokens / usage.inputTokens) * 100) : 0;
        const stats = `${event.rounds} round(s) | in ${usage.inputTokens} (cache hit ${hitRate}%) | out ${usage.outputTokens} | context ${event.contextTokens} | $${usage.costUsd.toFixed(5)}`;
        if (event.reason === 'error') this.line(`  [error] ${event.error}`);
        else if (event.reason === 'handoff') this.line(`  [handed off to ${event.handoff?.to}]`);
        else if (event.reason !== 'stop') this.line(`  [stopped: ${event.reason}${event.error ? ` - ${event.error}` : ''}]`);
        this.line(`  (${stats})`);
        break;
      }
      default:
        break;
    }
  }
}

/** Handles a slash command. Returns the (possibly switched) agent. */
async function runCommand(
  line: string,
  core: Core,
  agentsDir: string,
  agent: AgentDefinition,
): Promise<AgentDefinition> {
  const [command, ...rest] = line.split(/\s+/);
  const argument = rest.join(' ').trim();

  switch (command) {
    case '/help':
      console.log(HELP);
      break;
    case '/agents':
      console.log(listAgents(agentsDir).join(', '));
      break;
    case '/triggers': {
      const active = core.triggers.list('active');
      console.log(
        active.length > 0
          ? active
              .map((trigger) => `#${trigger.id} ${trigger.kind} "${trigger.title}" next ${trigger.nextFireAt} ${trigger.cron ? `(cron ${trigger.cron})` : ''}`)
              .join('\n')
          : 'No active triggers.',
      );
      break;
    }
    case '/agent': {
      const next = core.agents.get(argument);
      console.log(`Now chatting with ${next.name}.`);
      return next;
    }
    case '/models':
      console.log(formatModelList(core.registry, argument || undefined));
      break;
    case '/model': {
      if (!argument) {
        console.log(`Chat model: ${formatModelRef(core.deps.models.resolve('chat', agent.models))}`);
        break;
      }
      core.registry.info(parseModelRef(argument)); // rejects unknown models with suggestions
      console.log(`${agent.name} now uses ${argument} for this session.`);
      return { ...agent, models: { ...agent.models, model: argument } };
    }
    case '/memory': {
      const [action, path] = rest;
      if (!action) console.log(formatMemoryList(core.memory));
      else if (action === 'show' && path) console.log(formatMemoryEntry(core.memory, path));
      else if (action === 'delete' && path) {
        console.log(core.memory.delete(path) ? `Deleted ${path}. ${MEMORY_NOTE}` : `No memory file "${path}".`);
      } else console.log(HELP);
      break;
    }
    case '/compact':
      console.log('Compacting...');
      console.log(describeCompaction(await core.compactor.compactNow('main', agent)));
      break;
    default:
      console.log(`Unknown command. ${HELP}`);
  }
  return agent;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { agent: { type: 'string' }, model: { type: 'string' } },
  });
  // Keys, folders and per-agent models saved from the app's settings screen count here too.
  const appSettings = AppSettings.load(loadConfig().appSettingsPath);
  appSettings.applyToEnv(process.env);
  const config = loadConfig();
  if (appSettings.timezone) config.timezone = appSettings.timezone;
  fs.mkdirSync(config.allowedDirs[0]!, { recursive: true });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = new LineReader(rl);
  const core = await createCore(config, new CliBroker(lines), {
    app: appSettings,
  });
  const startAgent = values.agent ?? core.defaultAgentName();
  if (!startAgent) {
    console.log('No agents yet. Create one in the app (Agent screen) or add a folder under user/agents/ with an agent.md.');
    rl.close();
    await core.close();
    return;
  }
  let agent: AgentDefinition = core.agents.get(startAgent);
  if (values.model) {
    core.registry.info(parseModelRef(values.model));
    agent = { ...agent, models: { ...agent.models, model: values.model } };
  }

  // Reminders and scheduled tasks fire while the chat is open; they show up before the next prompt.
  core.listeners.notification = (notification) =>
    core.jobs.note(`${notification.kind}: ${notification.title} - ${notification.body}`);
  core.scheduler.start();

  let activeRun: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (activeRun) activeRun.abort();
    else rl.close();
  });

  const chatModel = formatModelRef(core.deps.models.resolve('chat', agent.models));
  console.log(`Chatting with ${agent.name} (${chatModel}). Type /help for commands.`);
  console.log(`Allowed folders: ${config.allowedDirs.join('; ')}\n`);

  while (true) {
    for (const notice of core.jobs.drainNotices()) console.log(`  [${notice}]`);
    const line = (await lines.next('you> '))?.trim();
    if (line === undefined || line === '/exit' || line === '/quit') break;
    if (!line) continue;

    try {
      if (line.startsWith('/')) {
        agent = await runCommand(line, core, config.agentsDir, agent);
        continue;
      }
      activeRun = new AbortController();
      const renderer = new Renderer();
      for await (const event of core.runTurn({ agent, userText: line, signal: activeRun.signal })) {
        renderer.handle(event);
      }
    } catch (error) {
      console.log(`[error] ${(error as Error).message}`);
    }
    activeRun = null;
    console.log();
  }

  rl.close();
  await core.close();
  for (const notice of core.jobs.drainNotices()) console.log(`  [${notice}]`);
}

await main();
