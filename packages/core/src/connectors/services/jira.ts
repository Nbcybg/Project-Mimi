import type { ConnectorField, ConnectorSpec } from '@mimi/shared';

const cloudId: ConnectorField = {
  key: 'cloudId',
  label: 'Cloud ID',
  type: 'string',
  required: true,
  description: 'Atlassian cloud id ของ site เช่น 12345678-abcd-...',
};

export const jiraConnector: ConnectorSpec = {
  key: 'jira',
  label: 'Jira',
  category: 'project-management',
  description: 'ค้นหา issue และอัปเดตงานใน Jira Cloud',
  baseUrl: 'https://api.atlassian.com',
  auth: {
    kind: 'basic',
    fields: [
      { key: 'username', label: 'Email', type: 'string', required: true, placeholder: 'you@example.com' },
      { key: 'password', label: 'API token', type: 'secret', required: true },
    ],
    scopes: ['read:jira-work', 'write:jira-work'],
  },
  operations: [
    {
      key: 'list_projects',
      label: 'List projects',
      method: 'GET',
      path: '/ex/jira/{cloudId}/rest/api/3/project/search',
      risk: 'read',
      fields: [cloudId, { key: 'maxResults', label: 'Max results', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'values' },
    },
    {
      key: 'search_issues',
      label: 'Search issues',
      method: 'GET',
      path: '/ex/jira/{cloudId}/rest/api/3/search',
      risk: 'read',
      fields: [
        cloudId,
        { key: 'jql', label: 'JQL', type: 'string', required: true, placeholder: 'project = MIMI ORDER BY created DESC' },
        { key: 'maxResults', label: 'Max results', type: 'number', required: false, default: 50 },
      ],
      response: { itemsPath: 'issues' },
    },
    {
      key: 'create_issue',
      label: 'Create issue',
      method: 'POST',
      path: '/ex/jira/{cloudId}/rest/api/3/issue',
      risk: 'write',
      body: {
        fields: {
          project: { key: '{{projectKey}}' },
          issuetype: { name: '{{issueType}}' },
          summary: '{{summary}}',
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{description}}' }] }],
          },
        },
      },
      fields: [
        cloudId,
        { key: 'projectKey', label: 'Project key', type: 'string', required: true, placeholder: 'MIMI' },
        { key: 'issueType', label: 'Issue type', type: 'string', required: true, default: 'Task' },
        { key: 'summary', label: 'Summary', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string', required: false, default: '' },
      ],
    },
    {
      key: 'update_issue',
      label: 'Update issue',
      method: 'PUT',
      path: '/ex/jira/{cloudId}/rest/api/3/issue/{issueKey}',
      risk: 'write',
      body: { fields: { summary: '{{summary}}' } },
      fields: [cloudId, { key: 'issueKey', label: 'Issue key', type: 'string', required: true }, { key: 'summary', label: 'Summary', type: 'string', required: true }],
    },
    {
      key: 'add_comment',
      label: 'Add comment',
      method: 'POST',
      path: '/ex/jira/{cloudId}/rest/api/3/issue/{issueKey}/comment',
      risk: 'write',
      body: {
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{comment}}' }] }],
        },
      },
      fields: [cloudId, { key: 'issueKey', label: 'Issue key', type: 'string', required: true }, { key: 'comment', label: 'Comment', type: 'string', required: true }],
    },
  ],
};
