import { z } from 'zod';
import { defineTool } from '@mimi/shared';
import { browserSession, formatSnapshot } from './browser.ts';

/**
 * Internal tool: only the core's `browser_fill_secret` calls it, after reading a value
 * from the vault. The value is never shown in the summary or the result, and the page
 * snapshot hides the field's contents.
 */
export const browserFillSecretTool = defineTool({
  name: 'browser_fill_secret',
  description:
    'Fill a password or payment field on the current page with a value the core resolved from the vault. Only sensitive fields are accepted; the value is never returned.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    ref: z.string().min(2).describe('Password or payment field ref from the latest snapshot'),
    value: z.string().min(1).max(512),
    clear: z.boolean().optional().describe('Replace the current content (default true)'),
    submit: z.boolean().optional().describe('Press Enter after filling'),
  }),
  summarize: (input) => `Fill ${input.ref} from the vault`,
  execute: (input) =>
    browserSession().run(async () => {
      const browser = browserSession();
      const result = await browser.typeSecret(input.ref, input.value, { clear: input.clear, submit: input.submit });
      const snapshot = formatSnapshot(await browser.snapshot());
      // A page may echo the value in visible text (e.g. a confirmation line): never hand it back.
      const visible = input.value.length >= 3 ? snapshot.split(input.value).join('[redacted]') : snapshot;
      return `Filled ${input.ref} from the vault. Now: ${result.title || '(no title)'} - ${result.url}\n\n${visible}`;
    }),
});
