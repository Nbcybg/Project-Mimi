import type { ConnectorField, ConnectorSpec } from '@mimi/shared';

const accountSid: ConnectorField = {
  key: 'accountSid',
  label: 'Account SID',
  type: 'string',
  required: true,
  placeholder: 'AC...',
};

export const twilioConnector: ConnectorSpec = {
  key: 'twilio',
  label: 'Twilio',
  category: 'communication',
  description: 'ส่ง SMS และอ่านข้อความหรือสายที่บันทึกไว้ใน Twilio',
  baseUrl: 'https://api.twilio.com/2010-04-01/Accounts',
  auth: {
    kind: 'basic',
    fields: [
      { key: 'username', label: 'Account SID', type: 'string', required: true },
      { key: 'password', label: 'Auth token', type: 'secret', required: true },
    ],
  },
  operations: [
    {
      key: 'send_sms',
      label: 'Send SMS',
      method: 'POST',
      path: '/{accountSid}/Messages.json',
      risk: 'write',
      bodyFormat: 'form',
      body: { To: '{{to}}', From: '{{from}}', Body: '{{body}}' },
      fields: [
        accountSid,
        { key: 'to', label: 'To', type: 'string', required: true, placeholder: '+66812345678' },
        { key: 'from', label: 'From', type: 'string', required: true, placeholder: '+15005550006' },
        { key: 'body', label: 'Message', type: 'string', required: true },
      ],
    },
    {
      key: 'list_messages',
      label: 'List messages',
      method: 'GET',
      path: '/{accountSid}/Messages.json',
      risk: 'read',
      fields: [accountSid, { key: 'PageSize', label: 'Page size', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'messages' },
    },
    {
      key: 'get_message',
      label: 'Get message',
      method: 'GET',
      path: '/{accountSid}/Messages/{sid}.json',
      risk: 'read',
      fields: [accountSid, { key: 'sid', label: 'Message SID', type: 'string', required: true }],
    },
    {
      key: 'list_calls',
      label: 'List calls',
      method: 'GET',
      path: '/{accountSid}/Calls.json',
      risk: 'read',
      fields: [accountSid, { key: 'PageSize', label: 'Page size', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'calls' },
    },
    {
      key: 'get_call',
      label: 'Get call',
      method: 'GET',
      path: '/{accountSid}/Calls/{sid}.json',
      risk: 'read',
      fields: [accountSid, { key: 'sid', label: 'Call SID', type: 'string', required: true }],
    },
  ],
};
