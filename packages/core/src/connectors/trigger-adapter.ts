import type {
  ConnectorField,
  ConnectorSpec,
  ConnectorTrigger,
  JsonValue,
  NodeTypeField,
  TriggerPoolView,
} from '@mimi/shared';

export const CONNECTOR_TRIGGER_PREFIX = 'connector:';

export function connectorTriggerPoolName(connector: string, trigger: string): string {
  return `${CONNECTOR_TRIGGER_PREFIX}${connector}:${trigger}`;
}

export function parseConnectorTriggerPool(name: string): { connector: string; trigger: string } | undefined {
  if (!name.startsWith(CONNECTOR_TRIGGER_PREFIX)) return undefined;
  const rest = name.slice(CONNECTOR_TRIGGER_PREFIX.length);
  const [connector, trigger, ...extra] = rest.split(':');
  if (!connector || !trigger || extra.length > 0) return undefined;
  return { connector, trigger };
}

function nodeTypeOf(field: ConnectorField): NodeTypeField['type'] {
  if (field.type === 'secret' || field.type === 'select') return 'string';
  return field.type;
}

function toNodeField(field: ConnectorField): NodeTypeField {
  return {
    key: field.key,
    label: field.label,
    type: nodeTypeOf(field),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.type === 'select' && field.options ? { options: field.options.map((option) => String(option.value)) } : {}),
  };
}

function triggerFieldsOf(trigger: ConnectorTrigger): NodeTypeField[] {
  const fields = (trigger.fields ?? []).map(toNodeField);
  const keys = new Set(fields.map((field) => field.key));
  if (trigger.kind === 'poll' && !keys.has('everyMinutes')) {
    fields.push({
      key: 'everyMinutes',
      label: 'Every (minutes)',
      type: 'number',
      required: false,
      description: 'How often the connector is polled; 5-1440 minutes, default 15.',
    });
  }
  return fields;
}

export function connectorTriggerView(spec: ConnectorSpec, trigger: ConnectorTrigger): TriggerPoolView {
  return {
    name: connectorTriggerPoolName(spec.key, trigger.key),
    label: `${spec.label}: ${trigger.label}`,
    description: trigger.description ?? `${trigger.label} events from ${spec.label}.`,
    kind: trigger.kind,
    builtin: true,
    fields: triggerFieldsOf(trigger),
    sample: (trigger.sample ?? { id: 'sample_1', event: trigger.events?.[0] ?? trigger.key }) as Record<string, JsonValue>,
  };
}

export function connectorTriggerViews(specs: readonly ConnectorSpec[]): TriggerPoolView[] {
  const views: TriggerPoolView[] = [];
  for (const spec of specs) {
    for (const trigger of spec.triggers ?? []) views.push(connectorTriggerView(spec, trigger));
  }
  return views;
}

export function findConnectorTrigger(
  specs: readonly ConnectorSpec[],
  name: string,
): { spec: ConnectorSpec; trigger: ConnectorTrigger } | undefined {
  const parsed = parseConnectorTriggerPool(name);
  if (!parsed) return undefined;
  const spec = specs.find((entry) => entry.key === parsed.connector);
  const trigger = spec?.triggers?.find((entry) => entry.key === parsed.trigger);
  return spec && trigger ? { spec, trigger } : undefined;
}
