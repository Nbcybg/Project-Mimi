import type { WorkflowNode, WorkflowView } from '@mimi/shared';

/** What validation needs to know about the rest of the app. */
export interface WorkflowValidationContext {
  hasAgent(name: string): boolean;
  hasTool(name: string): boolean;
  hasTrigger(pool: string): boolean;
  workflowNames(agent: string): string[];
}

const isDynamic = (value: unknown): boolean => typeof value === 'string' && value.includes('{{');

/** One node may only name agents, tools and workflows that exist (expressions are checked at run time). */
export function validateWorkflowNode(node: WorkflowNode, agent: string, context: WorkflowValidationContext): void {
  const where = `node "${node.id}"`;
  if (node.type === 'agent' && !isDynamic(node.config.agent) && !context.hasAgent(String(node.config.agent ?? ''))) {
    throw new Error(`${where}: agent "${String(node.config.agent ?? '')}" does not exist.`);
  }
  if ((node.type === 'chat' || node.type === 'approval' || node.type === 'tool') && node.config.agent && !isDynamic(node.config.agent) && !context.hasAgent(String(node.config.agent))) {
    throw new Error(`${where}: agent "${String(node.config.agent)}" does not exist.`);
  }
  if (node.type === 'tool' && !isDynamic(node.config.tool) && !context.hasTool(String(node.config.tool ?? ''))) {
    throw new Error(`${where}: unknown tool "${String(node.config.tool ?? '')}".`);
  }
  if ((node.type === 'workflow' || node.type === 'loop') && !isDynamic(node.config.workflow) && !context.workflowNames(agent).includes(String(node.config.workflow ?? ''))) {
    throw new Error(`${where}: unknown workflow "${String(node.config.workflow ?? '')}".`);
  }
}

/** A workflow may only name agents, tools and a trigger type that exist. */
export function validateWorkflowView(view: WorkflowView, context: WorkflowValidationContext): void {
  if (!context.hasAgent(view.agent)) throw new Error(`Agent "${view.agent}" does not exist.`);
  if (!context.hasTrigger(view.trigger.pool)) throw new Error(`Unknown trigger "${view.trigger.pool}"; add it to the trigger pool first.`);
  if (view.errorWorkflow && view.errorWorkflow !== view.name && !context.workflowNames(view.agent).includes(view.errorWorkflow)) {
    throw new Error(`Error workflow "${view.errorWorkflow}" does not exist.`);
  }
  for (const node of view.nodes) validateWorkflowNode(node, view.agent, context);
}
