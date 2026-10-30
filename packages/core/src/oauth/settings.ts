import type { AccountService, ToolSettingField, ToolSettingValues } from '@mimi/shared';

/** The setting every account-aware tool carries; empty means "the default account of this service". */
export function accountSetting(service: AccountService, label?: string): ToolSettingField {
  return {
    key: 'account',
    label: label ?? (service === 'google' ? 'บัญชี Google' : service === 'microsoft' ? 'บัญชี Microsoft' : 'บัญชีเมล'),
    type: 'account',
    service,
    required: false,
    description: 'เว้นว่าง = บัญชีเริ่มต้นของเจ้านี้ (ตั้งได้ที่ Hub → บัญชี / Mail)',
  };
}

/** The account id a preset or workflow node named; undefined means the default account. */
export function accountOf(settings: { account?: unknown } | undefined): string | undefined {
  const value = settings?.account;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
