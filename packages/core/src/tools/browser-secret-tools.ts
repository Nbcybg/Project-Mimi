import { browserFillSecretTool } from '@mimi/pc-agent';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { PC_OFFLINE, type PcLink } from './executor.ts';

export interface BrowserSecretDeps {
  /** Reads a vault value; the value never reaches the model or the history. */
  secret(name: string): string | undefined;
  /** The PC agent, when one is connected. */
  pc?: PcLink;
  /** The core runs on the user's machine and may run PC tools in-process. */
  localPcTools: boolean;
}

const SECRET_NAME = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Fills a password or card field on the current browser page from the vault. The agent
 * passes a secret name, never the value; every call asks the user, even after a session
 * or forever grant. Only sensitive fields are accepted, and snapshots hide their values.
 */
export function createBrowserSecretTools(deps: BrowserSecretDeps) {
  return [
    defineTool({
      name: 'browser_fill_secret',
      description:
        'Fill a password or payment field on the current browser page with a value from the vault. Pass the field ref from browser_snapshot and the vault secret name (e.g. CARD_NUMBER); the value is never shown to you and is never stored in the chat. Every call asks the user first, and a snapshot shows the field as hidden afterwards.',
      risk: 'write',
      target: 'core',
      alwaysAsk: true,
      inputSchema: z.object({
        ref: z.string().min(2).describe('Password or payment field ref such as e12'),
        secret: z.string().min(1).max(80).regex(SECRET_NAME).describe('Vault secret name, e.g. CARD_NUMBER'),
        clear: z.boolean().optional().describe('Replace the current content (default true)'),
        submit: z.boolean().optional().describe('Press Enter after filling'),
      }),
      summarize: (input) => `Fill ${input.ref} with vault secret "${input.secret}"${input.submit ? ' and press Enter' : ''}`,
      async execute(input, context) {
        const value = deps.secret(input.secret);
        if (!value) {
          throw new Error(`No vault secret named "${input.secret}". Add it in Settings → Secrets first.`);
        }
        if (value.length > 512) throw new Error(`The vault secret "${input.secret}" is longer than 512 characters.`);
        const request = {
          ref: input.ref,
          value,
          ...(input.clear === undefined ? {} : { clear: input.clear }),
          ...(input.submit === undefined ? {} : { submit: input.submit }),
        };
        if (deps.pc?.online) return deps.pc.execute('browser_fill_secret', request, context);
        if (deps.localPcTools) return browserFillSecretTool.execute(request, context);
        throw new Error(PC_OFFLINE);
      },
    }),
  ];
}
