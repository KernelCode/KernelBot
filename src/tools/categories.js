/**
 * Smart tool filtering — send only relevant tools per request to save tokens.
 */

export const TOOL_CATEGORIES = {
  core: ['execute_command', 'read_file', 'write_file', 'list_directory', 'update_user_persona'],
  git: ['git_clone', 'git_checkout', 'git_commit', 'git_push', 'git_diff'],
  github: ['github_create_pr', 'github_get_pr_diff', 'github_post_review', 'github_create_repo', 'github_list_prs'],
  coding: ['spawn_claude_code'],
  docker: ['docker_ps', 'docker_logs', 'docker_exec', 'docker_compose'],
  process: ['process_list', 'kill_process', 'service_control'],
  monitor: ['disk_usage', 'memory_usage', 'cpu_usage', 'system_logs'],
  network: ['check_port', 'curl_url', 'nginx_reload'],
  browser: ['web_search', 'browse_website', 'screenshot_website', 'extract_content', 'send_image', 'interact_with_page'],
  jira: ['jira_get_ticket', 'jira_search_tickets', 'jira_list_my_tickets', 'jira_get_project_tickets'],
  linkedin: ['linkedin_create_post', 'linkedin_get_my_posts', 'linkedin_get_post', 'linkedin_comment_on_post', 'linkedin_get_comments', 'linkedin_like_post', 'linkedin_get_profile', 'linkedin_delete_post'],
  x: ['x_post_tweet', 'x_reply_to_tweet', 'x_get_my_tweets', 'x_get_tweet', 'x_search_tweets', 'x_like_tweet', 'x_retweet', 'x_delete_tweet', 'x_get_profile'],
};

const CATEGORY_KEYWORDS = {
  coding: ['code', 'fix', 'bug', 'implement', 'refactor', 'build', 'feature', 'develop', 'program', 'write code', 'add feature', 'change', 'update', 'modify', 'create app', 'scaffold', 'debug', 'patch', 'review'],
  git: ['git', 'commit', 'branch', 'merge', 'clone', 'pull', 'push', 'diff', 'stash', 'rebase', 'checkout', 'repo'],
  github: ['pr', 'pull request', 'github', 'review', 'merge request'],
  docker: ['docker', 'container', 'compose', 'image', 'kubernetes', 'k8s'],
  process: ['process', 'kill', 'restart', 'service', 'daemon', 'systemctl', 'pid'],
  monitor: ['disk', 'memory', 'cpu', 'usage', 'monitor', 'logs', 'status', 'health', 'space'],
  network: ['port', 'curl', 'http', 'nginx', 'network', 'api', 'endpoint', 'request', 'url', 'fetch'],
  browser: ['search', 'find', 'look up', 'browse', 'screenshot', 'scrape', 'website', 'web page', 'webpage', 'extract content', 'html', 'css selector'],
  jira: ['jira', 'ticket', 'issue', 'sprint', 'backlog', 'story', 'epic'],
  linkedin: ['linkedin', 'post on linkedin', 'linkedin post', 'linkedin comment', 'share on linkedin'],
  x: ['twitter', 'tweet', 'x post', 'x.com', 'retweet', 'post on x', 'post on twitter'],
};

// Categories that imply other categories
const CATEGORY_DEPS = {
  coding: ['git', 'github'],
  github: ['git'],
};

/**
 * Select relevant tools for a user message based on keyword matching.
 * Always includes 'core' tools. Falls back to ALL tools if nothing specific matched.
 */
export function selectToolsForMessage(userMessage, allTools) {
  const lower = userMessage.toLowerCase();
  const matched = new Set(['core']);

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(category);
        // Add dependencies
        const deps = CATEGORY_DEPS[category];
        if (deps) deps.forEach((d) => matched.add(d));
        break;
      }
    }
  }

  // Fallback: if only core matched, the request is ambiguous — send all tools
  if (matched.size === 1) {
    return allTools;
  }

  // Build the filtered tool name set
  const toolNames = new Set();
  for (const cat of matched) {
    const names = TOOL_CATEGORIES[cat];
    if (names) names.forEach((n) => toolNames.add(n));
  }

  return allTools.filter((t) => toolNames.has(t.name));
}

/**
 * After a tool is used, expand the tool set to include related categories
 * so the model can use follow-up tools it might need.
 */
export function expandToolsForUsed(usedToolNames, currentTools, allTools) {
  const currentNames = new Set(currentTools.map((t) => t.name));
  const needed = new Set();

  for (const name of usedToolNames) {
    // Find which category this tool belongs to
    for (const [cat, tools] of Object.entries(TOOL_CATEGORIES)) {
      if (tools.includes(name)) {
        // Add deps for that category
        const deps = CATEGORY_DEPS[cat];
        if (deps) {
          for (const dep of deps) {
            for (const t of TOOL_CATEGORIES[dep]) {
              if (!currentNames.has(t)) needed.add(t);
            }
          }
        }
        break;
      }
    }
  }

  if (needed.size === 0) return currentTools;

  const extra = allTools.filter((t) => needed.has(t.name));
  return [...currentTools, ...extra];
}
