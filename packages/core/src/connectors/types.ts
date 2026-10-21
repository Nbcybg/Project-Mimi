import type { ConnectorSpec } from '@mimi/shared';

/** The fetch implementation the runtime uses; tests pass a fake. */
export type ConnectorFetch = typeof fetch;

/** Resolved auth field values, e.g. `{ botToken: "xoxb-…" }`. Never log this object. */
export type ConnectorAuthValues = Record<string, string>;

/**
 * Finds the stored credential of a connector. `account` is the id a workflow or
 * preset named; undefined means the connector's default connection.
 */
export interface ConnectorAuthResolver {
  resolve(connector: string, account?: string): Promise<ConnectorAuthValues | undefined> | ConnectorAuthValues | undefined;
}

/** One connector spec paired with one of its operations. */
export interface ConnectorRoute {
  connector: ConnectorSpec;
  operation: ConnectorSpec['operations'][number];
}

/** A failure the model can read: names the connector/operation, never a credential. */
export class ConnectorError extends Error {
  readonly connector: string;
  readonly operation: string;

  constructor(message: string, connector: string, operation: string) {
    super(message);
    this.name = 'ConnectorError';
    this.connector = connector;
    this.operation = operation;
  }
}
