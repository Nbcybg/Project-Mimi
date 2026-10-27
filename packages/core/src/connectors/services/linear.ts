import type { ConnectorSpec } from '@mimi/shared';

export const linearConnector: ConnectorSpec = {
  key: 'linear',
  label: 'Linear',
  category: 'project-management',
  description: 'อ่านทีมและ issue รวมถึงสร้างหรือคอมเมนต์งานใน Linear',
  baseUrl: 'https://api.linear.app/graphql',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'Personal API key', type: 'secret', required: true }],
  },
  operations: [
    {
      key: 'list_teams',
      label: 'List teams',
      method: 'POST',
      path: '/',
      risk: 'read',
      body: { query: 'query { teams { nodes { id name key } } }' },
      fields: [],
      response: { itemsPath: 'data.teams.nodes' },
    },
    {
      key: 'list_issues',
      label: 'List issues',
      method: 'POST',
      path: '/',
      risk: 'read',
      body: {
        query: 'query($first: Int) { issues(first: $first) { nodes { id identifier title state { name } team { key } } } }',
        variables: { first: '{{first}}' },
      },
      fields: [{ key: 'first', label: 'How many', type: 'number', required: false, default: 25 }],
      response: { itemsPath: 'data.issues.nodes' },
    },
    {
      key: 'create_issue',
      label: 'Create issue',
      method: 'POST',
      path: '/',
      risk: 'write',
      body: {
        query: 'mutation($team: String!, $title: String!, $description: String) { issueCreate(input: { teamId: $team, title: $title, description: $description }) { issue { id identifier title } } }',
        variables: { team: '{{teamId}}', title: '{{title}}', description: '{{description}}' },
      },
      fields: [
        { key: 'teamId', label: 'Team ID', type: 'string', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string', required: false, default: '' },
      ],
      response: { itemsPath: 'data.issueCreate.issue' },
    },
    {
      key: 'update_issue',
      label: 'Update issue',
      method: 'POST',
      path: '/',
      risk: 'write',
      body: {
        query: 'mutation($id: String!, $title: String!) { issueUpdate(id: $id, input: { title: $title }) { issue { id identifier title } } }',
        variables: { id: '{{issueId}}', title: '{{title}}' },
      },
      fields: [
        { key: 'issueId', label: 'Issue ID', type: 'string', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true },
      ],
      response: { itemsPath: 'data.issueUpdate.issue' },
    },
    {
      key: 'add_comment',
      label: 'Add comment',
      method: 'POST',
      path: '/',
      risk: 'write',
      body: {
        query: 'mutation($issue: String!, $body: String!) { commentCreate(input: { issueId: $issue, body: $body }) { comment { id body } } }',
        variables: { issue: '{{issueId}}', body: '{{body}}' },
      },
      fields: [
        { key: 'issueId', label: 'Issue ID', type: 'string', required: true },
        { key: 'body', label: 'Comment', type: 'string', required: true },
      ],
      response: { itemsPath: 'data.commentCreate.comment' },
    },
  ],
  triggers: [
    {
      key: 'new_issues',
      label: 'New issues',
      description: 'ตรวจ issue ล่าสุดของ Linear ตามรอบเวลา',
      kind: 'poll',
      operation: 'list_issues',
      input: { first: 25 },
      idField: 'id',
      fields: [],
      sample: { id: 'issue_1', identifier: 'MIMI-1', title: 'Example issue' },
    },
  ],
};
