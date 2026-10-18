import type { PermissionRequest } from '@mimi/shared';
import type { LineReader } from '../cli/line-reader.ts';
import type { PermissionBroker } from './gate.ts';

/** Asks for approval in the terminal. Anything but y/yes is a denial. */
export class CliBroker implements PermissionBroker {
  private readonly lines: LineReader;

  constructor(lines: LineReader) {
    this.lines = lines;
  }

  async request(request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    process.stdout.write(
      `\n[permission] ${request.agent} wants to use ${request.tool} (${request.risk})\n  ${request.summary}\n`,
    );
    const answer = await this.lines.next('Allow? [y/N] ', signal);
    return /^(y|yes)$/i.test(answer?.trim() ?? '');
  }
}
