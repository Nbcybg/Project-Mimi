import type { ConnectorField, ConnectorSpec } from '@mimi/shared';

const guildId: ConnectorField = {
  key: 'guildId',
  label: 'Guild ID',
  type: 'string',
  required: true,
  placeholder: '123456789012345678',
  description: 'คลิกขวาที่ server → Copy Server ID (ต้องเปิด Developer Mode)',
};

const channelId: ConnectorField = {
  key: 'channelId',
  label: 'Channel ID',
  type: 'string',
  required: true,
  placeholder: '123456789012345678',
  description: 'คลิกขวาที่ channel → Copy Channel ID',
  optionsFrom: { connector: 'discord', operation: 'list_channels', labelField: 'name', valueField: 'id', dependsOn: ['guildId'] },
};

export const discordConnector: ConnectorSpec = {
  key: 'discord',
  label: 'Discord',
  category: 'communication',
  description: 'ส่งข้อความและอ่านข้อมูล server ผ่าน Discord Bot API',
  baseUrl: 'https://discord.com/api/v10',
  auth: {
    kind: 'apiKey',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        type: 'secret',
        required: true,
        placeholder: 'MTIz…',
        description: 'สร้างที่ Discord Developer Portal → Bot → Reset Token',
      },
    ],
    scopes: ['bot'],
    extra: { prefix: 'Bot ' },
  },
  operations: [
    {
      key: 'send_message',
      label: 'ส่งข้อความ',
      description: 'ส่งข้อความเข้า channel ด้วย bot',
      method: 'POST',
      path: '/channels/{channelId}/messages',
      risk: 'write',
      fields: [channelId, { key: 'content', label: 'ข้อความ', type: 'string', required: true }],
    },
    {
      key: 'list_guilds',
      label: 'ดูรายชื่อ server',
      description: 'อ่าน server ที่ bot เข้าร่วม',
      method: 'GET',
      path: '/users/@me/guilds',
      risk: 'read',
      fields: [],
    },
    {
      key: 'list_channels',
      label: 'ดูรายชื่อ channel',
      description: 'อ่าน channel ของ server ที่เลือก',
      method: 'GET',
      path: '/guilds/{guildId}/channels',
      risk: 'read',
      fields: [guildId],
    },
    {
      key: 'list_messages',
      label: 'อ่านข้อความใน channel',
      description: 'อ่านข้อความล่าสุดของ channel (ข้อความเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/channels/{channelId}/messages',
      risk: 'read',
      untrustedInput: true,
      fields: [
        channelId,
        { key: 'limit', label: 'จำนวน', type: 'number', required: false, default: 50, description: '1–100' },
        { key: 'before', label: 'ก่อน message id', type: 'string', required: false },
      ],
    },
    {
      key: 'delete_message',
      label: 'ลบข้อความ',
      description: 'ลบข้อความที่ bot ส่งไว้',
      method: 'DELETE',
      path: '/channels/{channelId}/messages/{messageId}',
      risk: 'delete',
      fields: [channelId, { key: 'messageId', label: 'Message ID', type: 'string', required: true }],
    },
  ],
  pagination: { mode: 'cursor', cursorParam: 'before', sizeParam: 'limit' },
  rateLimit: { requests: 5, perMs: 1000, burst: 5 },
};
