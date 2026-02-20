import axios from 'axios';
import { getLogger } from '../utils/logger.js';

/**
 * Create an axios instance configured for the JIRA REST API.
 * Supports both Atlassian Cloud (*.atlassian.net) and JIRA Server instances.
 *
 * Authentication:
 *   - Cloud: email + API token (Basic auth)
 *   - Server: username + password/token (Basic auth)
 *
 * Config precedence: config.jira.* → JIRA_* env vars
 */
function getJiraClient(config) {
  const baseUrl = config.jira?.base_url || process.env.JIRA_BASE_URL;
  const email = config.jira?.email || process.env.JIRA_EMAIL;
  const token = config.jira?.api_token || process.env.JIRA_API_TOKEN;

  if (!baseUrl) throw new Error('JIRA base URL not configured. Set JIRA_BASE_URL or jira.base_url in config.');
  if (!email) throw new Error('JIRA email/username not configured. Set JIRA_EMAIL or jira.email in config.');
  if (!token) throw new Error('JIRA API token not configured. Set JIRA_API_TOKEN or jira.api_token in config.');

  const cleanBase = baseUrl.replace(/\/+$/, '');

  return axios.create({
    baseURL: `${cleanBase}/rest/api/2`,
    auth: { username: email, password: token },
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

/**
 * Extract structured ticket data from a JIRA issue response.
 */
function formatIssue(issue) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    summary: fields.summary || '',
    description: fields.description || '',
    status: fields.status?.name || '',
    assignee: fields.assignee?.displayName || 'Unassigned',
    reporter: fields.reporter?.displayName || '',
    priority: fields.priority?.name || '',
    type: fields.issuetype?.name || '',
    labels: fields.labels || [],
    created: fields.created || '',
    updated: fields.updated || '',
    project: fields.project?.key || '',
  };
}

export const definitions = [
  {
    name: 'jira_get_ticket',
    description: 'Get details of a specific JIRA ticket by its key (e.g. PROJ-123).',
    input_schema: {
      type: 'object',
      properties: {
        ticket_key: {
          type: 'string',
          description: 'The JIRA ticket key (e.g. PROJ-123)',
        },
      },
      required: ['ticket_key'],
    },
  },
  {
    name: 'jira_search_tickets',
    description: 'Search for JIRA tickets using JQL (JIRA Query Language). Example: "project = PROJ AND status = Open".',
    input_schema: {
      type: 'object',
      properties: {
        jql_query: {
          type: 'string',
          description: 'JQL query string',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default 20)',
          default: 20,
        },
      },
      required: ['jql_query'],
    },
  },
  {
    name: 'jira_list_my_tickets',
    description: 'List JIRA tickets assigned to a user. Defaults to the authenticated user.',
    input_schema: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          description: 'Assignee username or "currentUser()" (default)',
          default: 'currentUser()',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'jira_get_project_tickets',
    description: 'Get tickets from a specific JIRA project.',
    input_schema: {
      type: 'object',
      properties: {
        project_key: {
          type: 'string',
          description: 'The JIRA project key (e.g. PROJ)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default 20)',
          default: 20,
        },
      },
      required: ['project_key'],
    },
  },
];

export const handlers = {
  /**
   * Get details of a specific JIRA ticket.
   * @param {{ ticket_key: string }} params
   * @param {{ config: object }} context
   */
  jira_get_ticket: async (params, context) => {
    try {
      const client = getJiraClient(context.config);
      const { data } = await client.get(`/issue/${params.ticket_key}`);
      return { ticket: formatIssue(data) };
    } catch (err) {
      if (err.response?.status === 404) {
        return { error: `Ticket ${params.ticket_key} not found` };
      }
      getLogger().error(`jira_get_ticket failed for ${params.ticket_key}: ${err.message}`);
      return { error: err.response?.data?.errorMessages?.join('; ') || err.message };
    }
  },

  /**
   * Search for JIRA tickets using JQL.
   * @param {{ jql_query: string, max_results?: number }} params
   * @param {{ config: object }} context
   */
  jira_search_tickets: async (params, context) => {
    try {
      const client = getJiraClient(context.config);
      const maxResults = params.max_results || 20;

      const { data } = await client.get('/search', {
        params: {
          jql: params.jql_query,
          maxResults,
          fields: 'summary,description,status,assignee,reporter,priority,issuetype,labels,created,updated,project',
        },
      });

      return {
        total: data.total,
        tickets: (data.issues || []).map(formatIssue),
      };
    } catch (err) {
      getLogger().error(`jira_search_tickets failed: ${err.message}`);
      return { error: err.response?.data?.errorMessages?.join('; ') || err.message };
    }
  },

  /**
   * List tickets assigned to a user.
   * @param {{ assignee?: string, max_results?: number }} params
   * @param {{ config: object }} context
   */
  jira_list_my_tickets: async (params, context) => {
    try {
      const client = getJiraClient(context.config);
      const assignee = params.assignee || 'currentUser()';
      const maxResults = params.max_results || 20;
      const jql = `assignee = ${assignee} ORDER BY updated DESC`;

      const { data } = await client.get('/search', {
        params: {
          jql,
          maxResults,
          fields: 'summary,description,status,assignee,reporter,priority,issuetype,labels,created,updated,project',
        },
      });

      return {
        total: data.total,
        tickets: (data.issues || []).map(formatIssue),
      };
    } catch (err) {
      getLogger().error(`jira_list_my_tickets failed: ${err.message}`);
      return { error: err.response?.data?.errorMessages?.join('; ') || err.message };
    }
  },

  /**
   * Get tickets from a specific JIRA project.
   * @param {{ project_key: string, max_results?: number }} params
   * @param {{ config: object }} context
   */
  jira_get_project_tickets: async (params, context) => {
    try {
      const client = getJiraClient(context.config);
      const maxResults = params.max_results || 20;
      const jql = `project = ${params.project_key} ORDER BY updated DESC`;

      const { data } = await client.get('/search', {
        params: {
          jql,
          maxResults,
          fields: 'summary,description,status,assignee,reporter,priority,issuetype,labels,created,updated,project',
        },
      });

      return {
        total: data.total,
        tickets: (data.issues || []).map(formatIssue),
      };
    } catch (err) {
      getLogger().error(`jira_get_project_tickets failed for ${params.project_key}: ${err.message}`);
      return { error: err.response?.data?.errorMessages?.join('; ') || err.message };
    }
  },
};
