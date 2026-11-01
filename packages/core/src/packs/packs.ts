import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentView,
  ConnectorSpec,
  JsonValue,
  PackCredentialView,
  PackRemoveView,
  PackReportView,
  PackSummaryView,
  ToolDefinition,
  WorkflowNode,
  WorkflowView,
} from '@mimi/shared';
import type { ImportedConnectors } from '../connectors/imported.ts';
import { AGENT_NAME, WORKFLOW_NAME } from '../workflows/workflow-store.ts';

/**
 * Packs: starter agents, OpenAPI connectors and workflows that belong together, installed
 * in one go with a list of the credentials they still need. A pack is data only (JSON); it
 * never carries a credential. Installing adds what is missing and never overwrites: an agent
 * or connector that exists is reused, a workflow name that is taken gets a suffix, and every
 * workflow is saved switched off so the user reviews it first. What was installed is kept in
 * `user/packs/<id>.json` so the checklist can be shown again later.
 */

export const PACK_FORMAT = 1;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_AGENTS = 8;
const MAX_CONNECTORS = 8;
const MAX_WORKFLOWS = 20;
const MAX_PROMPT = 20_000;
const PACK_ID = /^[a-z][a-z0-9-]{1,47}$/;
const SECRET_REF = /(?:\$secret\.|\{\{\s*secret\.)([A-Za-z_][A-Za-z0-9_]*)/g;

export interface PackAgent {
  name: string;
  displayName?: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

export interface PackConnector {
  key: string;
  label?: string;
  /** An OpenAPI 3.x document (object), imported like Hub > Node & Tools > นำเข้า OpenAPI. */
  openapi: Record<string, unknown>;
}

export type PackWorkflow = Pick<WorkflowView, 'name' | 'agent' | 'title' | 'description' | 'trigger' | 'nodes'> &
  Partial<Pick<WorkflowView, 'vars' | 'notes'>>;

export interface PackCredential {
  kind: PackCredentialView['kind'];
  key: string;
  label: string;
  why?: string;
  url?: string;
}

export interface MimiPack {
  format: number;
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  agents?: PackAgent[];
  connectors?: PackConnector[];
  workflows?: PackWorkflow[];
  credentials?: PackCredential[];
}

export interface PackDeps {
  dir: string;
  imported: ImportedConnectors;
  connector(key: string): ConnectorSpec | undefined;
  tool(name: string): ToolDefinition | undefined;
  agentNames(): string[];
  saveAgent(view: AgentView): void;
  /** Removes an agent and everything that belongs to it; false when it was already gone. */
  deleteAgent(name: string): boolean;
  hasTrigger(pool: string): boolean;
  workflowNames(agent: string): string[];
  /** Validates, stores and schedules; throws when the workflow is not valid. */
  saveWorkflow(view: WorkflowView): void;
  /** Removes one workflow and its schedules/runs; false when it was already gone. */
  deleteWorkflow(agent: string, name: string): boolean;
  /** Removes an imported connector and its tools; native connectors throw. */
  deleteConnector(key: string): void;
  /** True when a workflow or agent other than `ignore` still uses a tool of this connector. */
  connectorInUse(key: string, ignore: { workflows?: string[]; agents?: string[] }): boolean;
  credentialOk(kind: PackCredentialView['kind'], key: string): boolean;
}

export interface PackPlan {
  report?: PackReportView;
  errors: string[];
  /** Install only: something was written (errors then list the parts that failed). */
  installed?: boolean;
}

export interface PackRemovePlan {
  report?: PackRemoveView;
  errors: string[];
  /** Remove only: something was deleted. */
  removed?: boolean;
}

interface PackCreated {
  agents: string[];
  connectors: string[];
  workflows: Array<{ agent: string; name: string }>;
}

interface StoredPack {
  format: number;
  installedAt: string;
  builtin: boolean;
  pack: MimiPack;
  created?: PackCreated;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/** Reads a pack from JSON text (or an object); throws with the first thing that is wrong. */
export function parsePack(source: unknown): MimiPack {
  let raw: unknown = source;
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw new Error('the pack file is larger than 4 MB');
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new Error(`the pack is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (!isObject(raw)) throw new Error('a pack is a JSON object');
  if (raw.format !== PACK_FORMAT) throw new Error(`unknown pack format (expected "format": ${PACK_FORMAT})`);
  const id = text(raw.id, 48);
  if (!id || !PACK_ID.test(id)) throw new Error('"id" must be 2-48 characters: a-z, 0-9 and "-", starting with a letter');
  const name = text(raw.name, 80);
  const description = text(raw.description, 600);
  if (!name || !description) throw new Error('"name" and "description" are required');
  const list = <T>(key: string, max: number): T[] => {
    const value = raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`"${key}" must be a list`);
    if (value.length > max) throw new Error(`a pack has at most ${max} ${key}`);
    return value as T[];
  };
  const agents = list<unknown>('agents', MAX_AGENTS).map((entry, index) => {
    if (!isObject(entry)) throw new Error(`agents[${index}] is not an object`);
    const agentName = text(entry.name, 40)?.toLowerCase();
    if (!agentName || !AGENT_NAME.test(agentName) || agentName === 'overseer') throw new Error(`agents[${index}]: invalid name`);
    const tools = Array.isArray(entry.tools) ? entry.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 200) : [];
    return {
      name: agentName,
      displayName: text(entry.displayName, 60) ?? agentName,
      description: text(entry.description, 300) ?? '',
      systemPrompt: typeof entry.systemPrompt === 'string' ? entry.systemPrompt.slice(0, MAX_PROMPT) : '',
      tools,
    };
  });
  const connectors = list<unknown>('connectors', MAX_CONNECTORS).map((entry, index) => {
    if (!isObject(entry) || !isObject(entry.openapi)) throw new Error(`connectors[${index}] needs an "openapi" document`);
    const key = text(entry.key, 64);
    if (!key) throw new Error(`connectors[${index}] needs a "key"`);
    return { key, ...(text(entry.label, 80) ? { label: text(entry.label, 80)! } : {}), openapi: entry.openapi };
  });
  const workflows = list<unknown>('workflows', MAX_WORKFLOWS).map((entry, index) => {
    if (!isObject(entry)) throw new Error(`workflows[${index}] is not an object`);
    const workflowName = text(entry.name, 60);
    if (!workflowName || !WORKFLOW_NAME.test(workflowName)) throw new Error(`workflows[${index}]: invalid name`);
    const agent = text(entry.agent, 40);
    if (!agent) throw new Error(`workflows[${index}] needs an "agent"`);
    if (!isObject(entry.trigger) || typeof entry.trigger.pool !== 'string') throw new Error(`workflows[${index}] needs a trigger`);
    if (!Array.isArray(entry.nodes)) throw new Error(`workflows[${index}] needs "nodes"`);
    return {
      name: workflowName,
      agent,
      title: text(entry.title, 120) ?? workflowName,
      description: text(entry.description, 600) ?? '',
      trigger: { pool: entry.trigger.pool, config: isObject(entry.trigger.config) ? (entry.trigger.config as Record<string, JsonValue>) : {} },
      nodes: entry.nodes as WorkflowNode[],
      ...(isObject(entry.vars) ? { vars: entry.vars as Record<string, JsonValue> } : {}),
      ...(Array.isArray(entry.notes) ? { notes: entry.notes as PackWorkflow['notes'] } : {}),
    };
  });
  const kinds = new Set(['provider', 'connector', 'google', 'microsoft', 'secret']);
  const credentials = list<unknown>('credentials', 30).flatMap((entry) => {
    if (!isObject(entry) || !kinds.has(String(entry.kind)) || !text(entry.key, 64) || !text(entry.label, 120)) return [];
    const url = text(entry.url, 300);
    return [
      {
        kind: entry.kind as PackCredential['kind'],
        key: text(entry.key, 64)!,
        label: text(entry.label, 120)!,
        ...(text(entry.why, 300) ? { why: text(entry.why, 300)! } : {}),
        // Only plain https links are shown to the user.
        ...(url && /^https:\/\/[^\s"'<>]+$/.test(url) ? { url } : {}),
      },
    ];
  });
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.slice(0, 30)).slice(0, 10) : [];
  return {
    format: PACK_FORMAT,
    id,
    name,
    description,
    version: text(raw.version, 20) ?? '1.0.0',
    ...(text(raw.author, 80) ? { author: text(raw.author, 80)! } : {}),
    tags,
    agents,
    connectors,
    workflows,
    credentials,
  };
}

/** Reads a remote catalog: a JSON array of packs or `{ "packs": [...] }`. */
export function parsePackList(source: unknown, reserved: Iterable<string> = []): { packs: MimiPack[]; errors: string[] } {
  const list = Array.isArray(source) ? source : isObject(source) && Array.isArray(source.packs) ? source.packs : undefined;
  if (!list) return { packs: [], errors: ['a pack catalog is a JSON array or {"packs": [...]}'] };
  const ids = new Set(reserved);
  const packs: MimiPack[] = [];
  const errors: string[] = [];
  for (const [index, raw] of list.entries()) {
    try {
      const pack = parsePack(raw);
      if (ids.has(pack.id)) throw new Error(`"${pack.id}" is already in the catalog`);
      ids.add(pack.id);
      packs.push(pack);
    } catch (error) {
      errors.push(`packs[${index}]: ${(error as Error).message}`);
    }
  }
  return { packs, errors };
}

/** Which account a built-in tool works through, judged by its name. */
function accountOfTool(name: string): 'google' | 'microsoft' | null {
  if (/^(gmail|calendar|contacts|drive|sheets)_/.test(name)) return 'google';
  if (/^(outlook|onedrive)_/.test(name) || /^todo_(lists|tasks|create|update|delete)$/.test(name)) return 'microsoft';
  return null;
}

export function packSummary(pack: MimiPack, builtin: boolean, installedAt?: string): PackSummaryView {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    ...(pack.author ? { author: pack.author } : {}),
    tags: pack.tags ?? [],
    agents: (pack.agents ?? []).map((agent) => agent.displayName ?? agent.name),
    connectors: (pack.connectors ?? []).map((connector) => connector.label ?? connector.key),
    workflows: (pack.workflows ?? []).map((workflow) => workflow.title),
    builtin,
    ...(installedAt ? { installedAt } : {}),
  };
}

export class PackInstaller {
  private readonly deps: PackDeps;
  private readonly catalog: Map<string, MimiPack>;
  private readonly builtinIds: Set<string>;
  private readonly remoteIds: Set<string>;

  constructor(deps: PackDeps, catalog: MimiPack[] = [], remote: MimiPack[] = []) {
    this.deps = deps;
    this.builtinIds = new Set(catalog.map((pack) => pack.id));
    this.remoteIds = new Set(remote.map((pack) => pack.id));
    this.catalog = new Map([...catalog, ...remote].map((pack) => [pack.id, pack]));
  }

  catalogViews(): PackSummaryView[] {
    return [...this.catalog.values()].map((pack) => ({
      ...packSummary(pack, this.builtinIds.has(pack.id)),
      ...(this.remoteIds.has(pack.id) ? { remote: true } : {}),
    }));
  }

  /** A catalog pack by id, or a pack from JSON text; throws when neither works. */
  resolve(input: { id?: string; source?: string }): { pack: MimiPack; builtin: boolean } {
    if (input.source !== undefined) {
      const pack = parsePack(input.source);
      if (this.catalog.has(pack.id)) throw new Error(`"${pack.id}" is the id of a built-in pack or a remote catalog pack; give the file its own id`);
      return { pack, builtin: false };
    }
    const pack = this.catalog.get(String(input.id ?? ''));
    if (!pack) throw new Error(`no pack "${String(input.id ?? '')}" in the catalog`);
    return { pack, builtin: this.builtinIds.has(pack.id) };
  }

  private credentials(pack: MimiPack, workflows: PackWorkflow[], toolNames: string[], plannedConnectors: Map<string, ConnectorSpec>): PackCredentialView[] {
    const items = new Map<string, PackCredential>();
    const add = (item: PackCredential) => {
      const id = `${item.kind}:${item.key}`;
      if (!items.has(id)) items.set(id, item);
    };
    add({ kind: 'provider', key: 'model', label: 'ผู้ให้บริการโมเดล', why: 'agent และ node "agent" ต้องมีโมเดลคุยที่เชื่อมต่อแล้ว' });
    for (const item of pack.credentials ?? []) items.set(`${item.kind}:${item.key}`, item);
    const connectorKeys = new Set<string>([...plannedConnectors.keys(), ...(pack.connectors ?? []).map((connector) => connector.key)]);
    for (const workflow of workflows) {
      for (const node of workflow.nodes) {
        if (node.type === 'connector' && typeof node.config?.connector === 'string') connectorKeys.add(node.config.connector);
        if (node.type === 'tool' && typeof node.config?.tool === 'string') toolNames.push(node.config.tool);
      }
      for (const match of JSON.stringify(workflow).matchAll(SECRET_REF)) {
        add({ kind: 'secret', key: match[1]!, label: `ค่าลับ ${match[1]}`, why: `workflow "${workflow.title}" อ่านค่านี้จากคีย์ลับ` });
      }
    }
    for (const name of toolNames) {
      const account = accountOfTool(name);
      if (account) add({ kind: account, key: account, label: account === 'google' ? 'บัญชี Google' : 'บัญชี Microsoft', why: `เครื่องมือ ${name}` });
      const owner = [...plannedConnectors.values()].find((spec) => name.startsWith(`${spec.key}_`));
      const tool = this.deps.tool(name) as (ToolDefinition & { connector?: string }) | undefined;
      if (owner) connectorKeys.add(owner.key);
      else if (tool?.connector) connectorKeys.add(tool.connector);
    }
    for (const key of connectorKeys) {
      const spec = plannedConnectors.get(key) ?? this.deps.connector(key);
      if (!spec || spec.auth.kind === 'none') continue;
      if (spec.auth.kind === 'oauth2' && spec.auth.extra?.provider === 'google') {
        add({ kind: 'google', key: 'google', label: 'บัญชี Google', why: `connector ${spec.label}` });
      } else {
        add({ kind: 'connector', key, label: `Connection ของ ${spec.label}`, why: `${spec.auth.kind} · ตั้งที่ Hub → บัญชี` });
      }
    }
    return [...items.values()].map((item) => ({ ...item, ok: this.deps.credentialOk(item.kind, item.key) }));
  }

  /** Checks a pack against this app without changing anything. */
  plan(pack: MimiPack): PackPlan {
    const errors: string[] = [];
    const warnings: string[] = [];
    const planned = new Map<string, ConnectorSpec>();
    const connectors: PackReportView['connectors'] = [];
    for (const entry of pack.connectors ?? []) {
      if (this.deps.imported.has(entry.key)) {
        const spec = this.deps.connector(entry.key)!;
        connectors.push({ key: entry.key, label: spec.label, action: 'reuse', operations: spec.operations.length });
        warnings.push(`connector "${entry.key}" นำเข้าไว้แล้ว ใช้ตัวเดิม`);
        continue;
      }
      if (this.deps.connector(entry.key)) {
        errors.push(`connector "${entry.key}": the key of a built-in connector`);
        continue;
      }
      const result = this.deps.imported.plan(JSON.stringify(entry.openapi), { key: entry.key, ...(entry.label ? { label: entry.label } : {}) });
      if (result.errors.length > 0 || !result.spec) {
        errors.push(...result.errors.map((error) => `connector "${entry.key}": ${error}`));
        continue;
      }
      planned.set(result.spec.key, result.spec);
      connectors.push({ key: result.spec.key, label: result.spec.label, action: 'import', operations: result.spec.operations.length });
    }

    const plannedTools = new Map<string, { risk: string; untrusted: boolean }>();
    for (const spec of planned.values()) {
      for (const operation of spec.operations) plannedTools.set(`${spec.key}_${operation.key}`, { risk: operation.risk, untrusted: true });
    }
    const toolInfo = (name: string) => {
      const tool = this.deps.tool(name);
      return tool ? { risk: tool.risk, untrusted: Boolean(tool.untrustedInput && !tool.allowWithShell) } : plannedTools.get(name);
    };

    const existing = new Set(this.deps.agentNames());
    const agents: PackReportView['agents'] = [];
    for (const agent of pack.agents ?? []) {
      const reuse = existing.has(agent.name);
      const unknown = agent.tools.filter((name) => !toolInfo(name));
      if (!reuse && unknown.length > 0) errors.push(`agent "${agent.name}": unknown tools ${unknown.join(', ')}`);
      const known = agent.tools.filter((name) => toolInfo(name));
      if (!reuse && known.some((name) => toolInfo(name)!.untrusted) && known.some((name) => toolInfo(name)!.risk === 'shell')) {
        errors.push(`agent "${agent.name}": tools that read outside content cannot share an agent with shell tools`);
      }
      const risky = known.filter((name) => ['shell', 'delete'].includes(toolInfo(name)!.risk));
      if (reuse) warnings.push(`มี agent "${agent.name}" อยู่แล้ว workflow ของแพ็กจะใช้ตัวนี้ (ไม่แก้เครื่องมือหรือคำสั่งของมัน)`);
      agents.push({ name: agent.name, displayName: agent.displayName ?? agent.name, action: reuse ? 'reuse' : 'create', tools: agent.tools, risky, systemPrompt: agent.systemPrompt });
    }

    const agentNames = new Set([...existing, ...(pack.agents ?? []).map((agent) => agent.name)]);
    const connectorKnown = (key: string) => planned.has(key) || Boolean(this.deps.connector(key));
    const workflows: PackReportView['workflows'] = [];
    const taken = new Map<string, Set<string>>();
    for (const workflow of pack.workflows ?? []) {
      const where = `workflow "${workflow.name}"`;
      if (!agentNames.has(workflow.agent)) errors.push(`${where}: agent "${workflow.agent}" is neither in the pack nor in this app`);
      if (!this.deps.hasTrigger(workflow.trigger.pool)) errors.push(`${where}: unknown trigger "${workflow.trigger.pool}"`);
      for (const node of workflow.nodes) {
        if (!isObject(node) || typeof node.id !== 'string' || typeof node.type !== 'string' || !isObject(node.config)) {
          errors.push(`${where}: a node is malformed`);
          continue;
        }
        const config = node.config;
        if (node.type === 'connector' && typeof config.connector === 'string' && !config.connector.includes('{{') && !connectorKnown(config.connector)) {
          errors.push(`${where}: unknown connector "${config.connector}"`);
        }
        if (node.type === 'tool' && typeof config.tool === 'string' && !config.tool.includes('{{') && !toolInfo(config.tool)) {
          errors.push(`${where}: unknown tool "${config.tool}"`);
        }
        if ((node.type === 'agent' || node.type === 'agent_call') && typeof config.agent === 'string' && !config.agent.includes('{{') && !agentNames.has(config.agent)) {
          errors.push(`${where}: agent "${config.agent}" is neither in the pack nor in this app`);
        }
      }
      const names = taken.get(workflow.agent) ?? new Set(existing.has(workflow.agent) ? this.deps.workflowNames(workflow.agent) : []);
      taken.set(workflow.agent, names);
      let finalName = workflow.name;
      for (let index = 2; names.has(finalName); index += 1) finalName = `${workflow.name}-${index}`;
      names.add(finalName);
      if (finalName !== workflow.name) warnings.push(`มี workflow "${workflow.name}" อยู่แล้ว ตัวใหม่ใช้ชื่อ "${finalName}"`);
      workflows.push({ name: finalName, agent: workflow.agent, title: workflow.title, trigger: workflow.trigger.pool });
    }
    warnings.push('workflow ทุกตัวถูกบันทึกแบบปิดไว้ ตรวจแล้วเปิดเองที่หน้า Workflow');

    const report: PackReportView = {
      id: pack.id,
      name: pack.name,
      agents,
      connectors,
      workflows,
      // What the workflows need; tools an agent merely may use (e.g. Gmail for a secretary) are not required.
      credentials: this.credentials(pack, pack.workflows ?? [], [], planned),
      warnings,
    };
    return { report, errors };
  }

  /**
   * Installs what the plan allows: connectors, then agents, then workflows (off). Parts that
   * fail are listed in `errors`; the rest stays installed.
   */
  install(pack: MimiPack, builtin: boolean): PackPlan {
    const plan = this.plan(pack);
    if (!plan.report || plan.errors.length > 0) return plan;
    const errors: string[] = [];
    const previous = this.readStored(pack.id)?.created;
    const created: PackCreated = {
      agents: [...new Set(previous?.agents ?? [])],
      connectors: [...new Set(previous?.connectors ?? [])],
      workflows: [...(previous?.workflows ?? [])],
    };
    for (const entry of pack.connectors ?? []) {
      const row = plan.report.connectors.find((connector) => connector.key === entry.key);
      if (row?.action !== 'import') continue;
      const saved = this.deps.imported.save(JSON.stringify(entry.openapi), { key: entry.key, ...(entry.label ? { label: entry.label } : {}) });
      errors.push(...saved.errors.map((error) => `connector "${entry.key}": ${error}`));
      if (saved.errors.length === 0 && !created.connectors.includes(entry.key)) created.connectors.push(entry.key);
    }
    for (const agent of pack.agents ?? []) {
      if (plan.report.agents.find((row) => row.name === agent.name)?.action !== 'create') continue;
      try {
        this.deps.saveAgent({
          name: agent.name,
          displayName: agent.displayName ?? agent.name,
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          models: {},
          tools: agent.tools,
          canMessage: [],
          budgets: { maxRounds: 12, maxTokens: 200_000 },
        });
        if (!created.agents.includes(agent.name)) created.agents.push(agent.name);
      } catch (error) {
        errors.push(`agent "${agent.name}": ${(error as Error).message}`);
      }
    }
    for (const [index, workflow] of (pack.workflows ?? []).entries()) {
      const row = plan.report.workflows[index]!;
      try {
        this.deps.saveWorkflow({
          name: row.name,
          agent: workflow.agent,
          title: workflow.title,
          description: workflow.description,
          enabled: false,
          trigger: workflow.trigger,
          webhook: null,
          nodes: workflow.nodes,
          ...(workflow.vars ? { vars: workflow.vars } : {}),
          ...(workflow.notes ? { notes: workflow.notes } : {}),
        });
        if (!created.workflows.some((entry) => entry.agent === row.agent && entry.name === row.name)) {
          created.workflows.push({ agent: row.agent, name: row.name });
        }
      } catch (error) {
        errors.push(`workflow "${row.name}": ${(error as Error).message}`);
      }
    }
    const stored: StoredPack = { format: PACK_FORMAT, installedAt: new Date().toISOString(), builtin, pack, created };
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const file = path.join(this.deps.dir, `${pack.id}.json`);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    // The checklist after installing: connectors that now exist may need a connection.
    const after = this.plan(pack).report;
    return { report: { ...plan.report, credentials: after?.credentials ?? plan.report.credentials }, errors, installed: true };
  }

  private readStored(id: string): StoredPack | undefined {
    if (!PACK_ID.test(id)) return undefined;
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(this.deps.dir, `${id}.json`), 'utf8')) as StoredPack;
      parsePack(stored.pack);
      return stored;
    } catch {
      return undefined;
    }
  }

  /**
   * Lists what removing an installed pack would delete, or deletes it. Only items the pack
   * created are touched; something another workflow or agent still uses is kept and listed.
   */
  remove(id: string, apply = false): PackRemovePlan {
    if (!PACK_ID.test(id)) return { errors: [`"${id}" is not a pack id`] };
    const stored = this.readStored(id);
    if (!stored) return { errors: [`no installed pack "${id}"`] };
    const pack = parsePack(stored.pack);
    const report: PackRemoveView = { id: pack.id, name: pack.name, remove: { agents: [], connectors: [], workflows: [] }, kept: [] };
    const errors: string[] = [];
    if (!stored.created) {
      report.legacy = true;
      for (const agent of pack.agents ?? []) report.kept.push({ kind: 'agent', name: agent.name, reason: 'installed before removal tracked ownership; kept' });
      for (const connector of pack.connectors ?? []) report.kept.push({ kind: 'connector', name: connector.key, reason: 'installed before removal tracked ownership; kept' });
      for (const workflow of pack.workflows ?? []) report.kept.push({ kind: 'workflow', name: `${workflow.agent}/${workflow.name}`, reason: 'installed before removal tracked ownership; kept' });
      if (apply) fs.rmSync(path.join(this.deps.dir, `${id}.json`), { force: true });
      return { report, errors, removed: apply };
    }

    const existingAgents = new Set(this.deps.agentNames());
    const names = new Map<string, string[]>();
    const workflowNames = (agent: string): string[] => {
      if (!names.has(agent)) names.set(agent, this.deps.workflowNames(agent));
      return names.get(agent)!;
    };
    const planned = new Set<string>();
    for (const workflow of stored.created.workflows) {
      if (!workflowNames(workflow.agent).includes(workflow.name)) continue;
      report.remove.workflows.push(workflow);
      planned.add(`${workflow.agent}/${workflow.name}`);
    }
    const agents: string[] = [];
    for (const agent of stored.created.agents) {
      if (!existingAgents.has(agent)) continue;
      const remaining = workflowNames(agent).filter((name) => !planned.has(`${agent}/${name}`));
      if (remaining.length > 0) {
        report.kept.push({ kind: 'agent', name: agent, reason: `still has workflow(s): ${remaining.join(', ')}` });
        continue;
      }
      agents.push(agent);
      report.remove.agents.push(agent);
    }
    const ignore = { workflows: [...planned], agents };
    for (const key of stored.created.connectors) {
      if (!this.deps.connector(key)) continue;
      if (this.deps.connectorInUse(key, ignore)) {
        report.kept.push({ kind: 'connector', name: key, reason: 'still used by another workflow or agent' });
        continue;
      }
      report.remove.connectors.push(key);
    }

    if (!apply) return { report, errors };
    for (const workflow of [...report.remove.workflows]) {
      try {
        this.deps.deleteWorkflow(workflow.agent, workflow.name);
      } catch (error) {
        errors.push(`workflow "${workflow.name}": ${(error as Error).message}`);
      }
    }
    for (const agent of [...report.remove.agents]) {
      try {
        if (this.deps.workflowNames(agent).length > 0) {
          report.remove.agents.splice(report.remove.agents.indexOf(agent), 1);
          report.kept.push({ kind: 'agent', name: agent, reason: 'still has workflow(s) after removing the pack workflows' });
          continue;
        }
        this.deps.deleteAgent(agent);
      } catch (error) {
        errors.push(`agent "${agent}": ${(error as Error).message}`);
      }
    }
    for (const key of [...report.remove.connectors]) {
      try {
        this.deps.deleteConnector(key);
      } catch (error) {
        errors.push(`connector "${key}": ${(error as Error).message}`);
      }
    }
    if (errors.length === 0) fs.rmSync(path.join(this.deps.dir, `${id}.json`), { force: true });
    return { report, errors, removed: true };
  }

  /** Installed packs with their checklist as it is now; unreadable records are skipped. */
  installed(): PackSummaryView[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      try {
        const stored = JSON.parse(fs.readFileSync(path.join(this.deps.dir, name), 'utf8')) as StoredPack;
        const pack = parsePack(stored.pack);
        const planned = new Map<string, ConnectorSpec>();
        return [{ ...packSummary(pack, Boolean(stored.builtin), stored.installedAt), credentials: this.credentials(pack, pack.workflows ?? [], [], planned) }];
      } catch {
        return [];
      }
    });
  }
}
