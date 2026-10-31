import type { TaskReceiptView, TaskVerificationView } from '@mimi/shared';
import { z } from 'zod';
import type { TaskRecipe, TaskStepContext } from './types.ts';
import { TaskStoppedError, parseToolJson } from './util.ts';

const inputSchema = z.object({
  app: z.enum(['apple-mail', 'outlook', 'thunderbird']),
  email: z.string().email(),
  provider: z.enum(['gmail', 'outlook', 'yahoo', 'icloud', 'other']).optional(),
  display_name: z.string().max(120).optional(),
  test_recipient: z.string().email().optional(),
  incoming_host: z.string().optional(),
  incoming_port: z.number().int().min(1).max(65535).optional(),
  outgoing_host: z.string().optional(),
  outgoing_port: z.number().int().min(1).max(65535).optional(),
  menu_path: z.array(z.string()).min(1).max(6).optional(),
});

type MailInput = z.infer<typeof inputSchema>;

interface ComputerNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  secure?: boolean;
  disabled?: boolean;
}

interface ObserveResult {
  ok: boolean;
  activeApp: string;
  nodes: ComputerNode[];
}

interface MailState {
  appName: string;
  snapshot?: ObserveResult;
  filled: string[];
  passwordHandoff?: boolean;
  tested?: boolean;
  sent?: boolean;
}

const PRESETS: Record<string, { incoming: string; incomingPort: number; outgoing: string; outgoingPort: number }> = {
  gmail: { incoming: 'pop.gmail.com', incomingPort: 995, outgoing: 'smtp.gmail.com', outgoingPort: 465 },
  outlook: { incoming: 'outlook.office365.com', incomingPort: 995, outgoing: 'smtp.office365.com', outgoingPort: 587 },
  yahoo: { incoming: 'pop.mail.yahoo.com', incomingPort: 995, outgoing: 'smtp.mail.yahoo.com', outgoingPort: 465 },
  icloud: { incoming: 'pop.mail.me.com', incomingPort: 995, outgoing: 'smtp.mail.me.com', outgoingPort: 587 },
};

function appName(input: MailInput): string {
  return input.app === 'apple-mail' ? 'Mail' : input.app === 'outlook' ? 'Outlook' : 'Thunderbird';
}

function defaultMenu(input: MailInput): string[] {
  if (input.menu_path) return input.menu_path;
  if (input.app === 'apple-mail') return ['Mail', 'Settings'];
  if (input.app === 'outlook') return ['File', 'Account Settings'];
  return ['Tools', 'Account Settings'];
}

function observe(context: TaskStepContext<MailInput>, app: string): Promise<ObserveResult> {
  return context.runPc('computer_observe', { app }).then((text) => parseToolJson<ObserveResult>(text));
}

function find(snapshot: ObserveResult, pattern: RegExp): ComputerNode | undefined {
  return snapshot.nodes.find((node) => pattern.test(node.name) || (node.value ? pattern.test(node.value) : false));
}

async function typeField(
  context: TaskStepContext<MailInput>,
  state: MailState,
  pattern: RegExp,
  value: string | number | undefined,
  label: string,
): Promise<boolean> {
  if (value === undefined || value === '') return false;
  const snapshot = await observe(context, state.appName);
  state.snapshot = snapshot;
  const node = find(snapshot, pattern);
  if (!node || node.secure || node.disabled) return false;
  await context.runPc('computer_type', { ref: node.ref, text: String(value), app: state.appName });
  state.filled.push(label);
  return true;
}

async function clickField(context: TaskStepContext<MailInput>, state: MailState, pattern: RegExp): Promise<boolean> {
  const snapshot = await observe(context, state.appName);
  state.snapshot = snapshot;
  const node = find(snapshot, pattern);
  if (!node || node.disabled) return false;
  await context.runPc('computer_click', { ref: node.ref, app: state.appName });
  return true;
}

/**
 * Guided POP3 setup in a native mail app. It fills only non-secret fields; the
 * user types the password/OTP in the app. It tests the account and optionally
 * sends one test mail after a separate confirmation.
 */
export const mailPop3Recipe: TaskRecipe<MailInput> = {
  name: 'mail-pop3',
  description:
    'Assist a POP3 account setup in Apple Mail, Outlook or Thunderbird: activate the app, fill name/email/server/port fields, hand the password to the user, test the connection, optionally send one test mail after confirmation, and leave a receipt. Never types a password or OTP.',
  level: 'L3',
  inputSchema,
  interfaces: ['pc'],
  steps: [
    {
      id: 'prepare',
      title: 'Open the mail app',
      async run(context) {
        const state = context.state.data as unknown as MailState;
        state.appName = appName(context.input);
        state.filled = [];
        const listed = parseToolJson<{ apps: Array<{ name: string; active: boolean }> }>(
          await context.runPc('computer_app', { action: 'list' }),
        );
        const running = listed.apps.find((app) => app.name.toLowerCase().includes(state.appName.toLowerCase()));
        if (!running) throw new Error(`${state.appName} is not running. Open it, then run the task again.`);
        await context.runPc('computer_app', { action: 'activate', app: running.name });
        try {
          await context.runPc('computer_menu', { app: running.name, path: defaultMenu(context.input) });
        } catch {
          // The menu path differs between versions; the user can open settings manually.
        }
        const snapshot = await observe(context, running.name);
        state.snapshot = snapshot;
        return `${running.name}: ${snapshot.nodes.length} accessibility element(s).`;
      },
    },
    {
      id: 'confirm',
      title: 'Ask before controlling the app',
      async run(context) {
        const state = context.state.data as unknown as MailState;
        const decision = await context.confirm({
          tool: 'computer_click',
          risk: 'write',
          summary: `ให้ Mimi ช่วยตั้งค่าอีเมล POP3 ใน ${state.appName} สำหรับ ${context.input.email} — รหัสผ่าน/OTP คุณต้องพิมพ์ในแอปเอง`,
          input: { app: state.appName, email: context.input.email, provider: context.input.provider ?? 'other' },
        });
        if (!decision.allow) {
          throw new TaskStoppedError(
            decision.reason === 'timeout' ? 'The confirmation timed out; the mail app was not changed.' : 'The user did not approve the mail setup.',
          );
        }
        return 'Approved.';
      },
    },
    {
      id: 'fill',
      title: 'Fill the non-secret fields',
      async run(context) {
        const state = context.state.data as unknown as MailState;
        const preset = context.input.provider && context.input.provider !== 'other' ? PRESETS[context.input.provider] : undefined;
        const incoming = context.input.incoming_host ?? preset?.incoming;
        const incomingPort = context.input.incoming_port ?? preset?.incomingPort;
        const outgoing = context.input.outgoing_host ?? preset?.outgoing;
        const outgoingPort = context.input.outgoing_port ?? preset?.outgoingPort;
        await typeField(context, state, /full name|display name|ชื่อ/i, context.input.display_name, 'name');
        await typeField(context, state, /email|e-mail|อีเมล/i, context.input.email, 'email');
        await typeField(context, state, /incoming.*server|server.*incoming|pop|เซิร์ฟเวอร์ขาเข้า/i, incoming, 'incoming');
        await typeField(context, state, /incoming.*port|port.*incoming|พอร์ตขาเข้า/i, incomingPort, 'incoming port');
        await typeField(context, state, /outgoing.*server|server.*outgoing|smtp|เซิร์ฟเวอร์ขาออก/i, outgoing, 'outgoing');
        await typeField(context, state, /outgoing.*port|port.*outgoing|พอร์ตขาออก/i, outgoingPort, 'outgoing port');

        const snapshot = await observe(context, state.appName);
        state.snapshot = snapshot;
        const secure = snapshot.nodes.find((node) => node.secure);
        state.passwordHandoff = Boolean(secure);
        const decision = await context.confirm({
          tool: 'computer_click',
          risk: 'write',
          summary: secure
            ? `กรุณาพิมพ์รหัสผ่านในช่อง Password ของ ${state.appName} เอง (Mimi จะไม่พิมพ์แทน) แล้วกดอนุญาตเพื่อไปทดสอบการเชื่อมต่อ`
            : `กรุณาเปิดหน้าตั้งค่าบัญชีใน ${state.appName} พิมพ์รหัสผ่านเอง แล้วกดอนุญาตเพื่อไปทดสอบการเชื่อมต่อ`,
          input: { app: state.appName, passwordField: secure?.ref ?? null },
        });
        if (!decision.allow) throw new TaskStoppedError('The user did not continue after the password step.');
        return `Filled: ${state.filled.join(', ') || 'no matching field'}; password ${secure ? 'left to the user' : 'field not visible'}.`;
      },
    },
    {
      id: 'test',
      title: 'Test the connection',
      async run(context) {
        const state = context.state.data as unknown as MailState;
        const clicked = await clickField(context, state, /test|verify|ตรวจสอบ|ทดสอบ/i);
        if (!clicked) return 'No Test button was found; the user must test the account manually.';
        try {
          const waited = await context.runPc('computer_wait', { app: state.appName, text: 'success', timeout_ms: 30_000 });
          const snapshot = parseToolJson<ObserveResult>(waited);
          const failure = snapshot.nodes.find((node) => /fail|error|wrong|ไม่สำเร็จ|ผิดพลาด/i.test(`${node.name} ${node.value ?? ''}`));
          if (failure) throw new Error(`The mail app reported a problem: ${failure.name}`);
        } catch (error) {
          const snapshot = await observe(context, state.appName);
          const failure = snapshot.nodes.find((node) => /fail|error|wrong|ไม่สำเร็จ|ผิดพลาด/i.test(`${node.name} ${node.value ?? ''}`));
          if (failure) throw new Error(`The mail app reported a problem: ${failure.name}`);
          if (!/did not appear|timed out/i.test((error as Error).message)) throw error;
        }
        state.tested = true;
        return 'Connection test completed.';
      },
    },
    {
      id: 'send',
      title: 'Send a test mail',
      async run(context) {
        const state = context.state.data as unknown as MailState;
        if (!context.input.test_recipient) return 'No test recipient; skipped the test mail.';
        const compose = await clickField(context, state, /compose|new message|เขียน|ข้อความใหม่/i);
        if (!compose) return 'No Compose button was found; the user can send the test mail manually.';
        await typeField(context, state, /^to$|ถึง|recipient|ผู้รับ/i, context.input.test_recipient, 'test recipient');
        await typeField(context, state, /subject|หัวข้อ/i, 'Mimi test', 'subject');
        await typeField(context, state, /body|message|ข้อความ/i, 'This is a test message from Mimi.', 'body');
        const decision = await context.confirm({
          tool: 'computer_click',
          risk: 'write',
          summary: `ส่งอีเมลทดสอบไปที่ ${context.input.test_recipient} หรือไม่? การส่งอีเมลย้อนกลับไม่ได้`,
          input: { to: context.input.test_recipient, subject: 'Mimi test' },
        });
        if (!decision.allow) throw new TaskStoppedError('The user did not confirm the test mail; nothing was sent.');
        await clickField(context, state, /send|ส่ง/i);
        state.sent = true;
        return `Test mail to ${context.input.test_recipient} sent (or handed to the app).`;
      },
    },
    {
      id: 'report',
      title: 'Report the setup',
      async run(context) {
        const state = context.state.data as unknown as MailState;
        const verification: TaskVerificationView = {
          ok: true,
          summary: `POP3 setup for ${context.input.email} in ${state.appName}; password typed by the user${state.sent ? '; test mail sent' : ''}.`,
        };
        const receipt: TaskReceiptView = {
          summary: verification.summary,
          moved: 0,
          skipped: 0,
          failed: 0,
          examples: [context.input.email, ...(context.input.provider ? [context.input.provider] : [])],
          undoable: false,
        };
        context.update({ verification, receipt });
        return receipt.summary;
      },
    },
  ],
};
