import type { ConnectorField, ConnectorSpec } from '@mimi/shared';

const baseId: ConnectorField = {
  key: 'baseId',
  label: 'Base ID',
  type: 'string',
  required: true,
  placeholder: 'appXXXXXXXXXXXXXX',
  description: 'คัดลอกได้จาก URL ของ base หรือ Airtable API docs',
};

const table: ConnectorField = {
  key: 'table',
  label: 'Table',
  type: 'string',
  required: true,
  placeholder: 'Leads',
  description: 'ชื่อหรือ id ของตาราง',
};

const recordId: ConnectorField = {
  key: 'recordId',
  label: 'Record ID',
  type: 'string',
  required: true,
  placeholder: 'recXXXXXXXXXXXXXX',
};

export const airtableConnector: ConnectorSpec = {
  key: 'airtable',
  label: 'Airtable',
  category: 'productivity',
  description: 'อ่านและเขียน record ใน Airtable base',
  baseUrl: 'https://api.airtable.com/v0',
  auth: {
    kind: 'apiKey',
    fields: [
      {
        key: 'token',
        label: 'Personal access token',
        type: 'secret',
        required: true,
        placeholder: 'pat…',
        description: 'สร้างที่ Airtable → Developer hub → Personal access tokens',
      },
    ],
    scopes: ['data.records:read', 'data.records:write'],
  },
  operations: [
    {
      key: 'list_records',
      label: 'อ่าน record',
      description: 'อ่าน record จากตาราง (ข้อมูลเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/{baseId}/{table}',
      risk: 'read',
      untrustedInput: true,
      fields: [
        baseId,
        table,
        { key: 'maxRecords', label: 'จำนวนสูงสุด', type: 'number', required: false, default: 100 },
        { key: 'view', label: 'View', type: 'string', required: false },
        { key: 'filterByFormula', label: 'Filter formula', type: 'string', required: false, placeholder: "{Status}='New'" },
      ],
      response: { itemsPath: 'records' },
    },
    {
      key: 'get_record',
      label: 'อ่าน record เดียว',
      description: 'อ่าน record ตาม id',
      method: 'GET',
      path: '/{baseId}/{table}/{recordId}',
      risk: 'read',
      untrustedInput: true,
      fields: [baseId, table, recordId],
    },
    {
      key: 'create_record',
      label: 'สร้าง record',
      description: 'สร้าง record ใหม่ในตาราง',
      method: 'POST',
      path: '/{baseId}/{table}',
      risk: 'write',
      body: { fields: '{{fields}}', typecast: '{{typecast}}' },
      fields: [
        baseId,
        table,
        { key: 'fields', label: 'Fields (JSON)', type: 'json', required: true },
        { key: 'typecast', label: 'Typecast', type: 'boolean', required: false, default: false },
      ],
    },
    {
      key: 'update_record',
      label: 'แก้ไข record',
      description: 'อัปเดต field ของ record',
      method: 'PATCH',
      path: '/{baseId}/{table}/{recordId}',
      risk: 'write',
      body: { fields: '{{fields}}', typecast: '{{typecast}}' },
      fields: [
        baseId,
        table,
        recordId,
        { key: 'fields', label: 'Fields (JSON)', type: 'json', required: true },
        { key: 'typecast', label: 'Typecast', type: 'boolean', required: false, default: false },
      ],
    },
    {
      key: 'delete_record',
      label: 'ลบ record',
      description: 'ลบ record ออกจากตาราง',
      method: 'DELETE',
      path: '/{baseId}/{table}/{recordId}',
      risk: 'delete',
      fields: [baseId, table, recordId],
    },
  ],
};
