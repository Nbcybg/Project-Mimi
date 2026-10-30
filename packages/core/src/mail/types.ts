import type { MailIncomingSettings, MailOutgoingSettings } from '@mimi/shared';

export interface MailAccountConfig {
  id: string;
  kind: 'imap' | 'pop3';
  name: string;
  email?: string;
  incoming: MailIncomingSettings;
  outgoing?: MailOutgoingSettings;
  default?: boolean;
}

export interface MailSummary {
  id: string;
  uid?: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  preview: string;
  seen: boolean;
  folder?: string;
  size?: number;
}

export interface MailSearchOptions {
  folder?: string;
  query?: string;
  unseenOnly?: boolean;
  sinceDays?: number;
  max?: number;
  markRead?: boolean;
}

export interface MailReadResult extends MailSummary {
  cc: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  attachments: Array<{ name: string; mime: string; bytes: number }>;
}

export interface MailSendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  fromName?: string;
  inReplyTo?: string;
  references?: string;
}

/** The exact connection settings to use, with defaults filled in. */
export function incomingPort(settings: MailIncomingSettings): number {
  if (settings.port > 0) return settings.port;
  if (settings.security === 'tls') return settings.protocol === 'pop3' ? 995 : 993;
  return settings.protocol === 'pop3' ? 110 : 143;
}

export function outgoingPort(settings: MailOutgoingSettings): number {
  if (settings.port > 0) return settings.port;
  if (settings.security === 'tls') return 465;
  if (settings.security === 'starttls') return 587;
  return 25;
}
