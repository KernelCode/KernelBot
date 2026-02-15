const DANGEROUS_PATTERNS = [
  { tool: 'execute_command', pattern: /\brm\b/, label: 'delete files' },
  { tool: 'execute_command', pattern: /\brmdir\b/, label: 'delete directories' },
  { tool: 'kill_process', pattern: null, label: 'kill a process' },
  { tool: 'service_control', param: 'action', value: 'stop', label: 'stop a service' },
  { tool: 'github_create_repo', pattern: null, label: 'create a GitHub repository' },
  { tool: 'docker_compose', param: 'action', value: 'down', label: 'take down containers' },
  { tool: 'git_push', param: 'force', value: true, label: 'force push' },
  { tool: 'interact_with_page', pattern: null, label: 'interact with a webpage (click, type, execute scripts)' },
];

export function requiresConfirmation(toolName, params, config) {
  // Check if confirmation is disabled in config
  if (config.security?.require_confirmation === false) return null;

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.tool !== toolName) continue;

    // Pattern match on command string
    if (rule.pattern && params.command && rule.pattern.test(params.command)) {
      return rule.label;
    }

    // Param value match
    if (rule.param && params[rule.param] === rule.value) {
      return rule.label;
    }

    // Tool-level match (no pattern/param — the tool itself is dangerous)
    if (!rule.pattern && !rule.param) {
      return rule.label;
    }
  }

  return null;
}
