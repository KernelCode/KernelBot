# KernelBot

[kernelbot.io](https://kernelbot.io) | [npm](https://www.npmjs.com/package/kernelbot) | [GitHub](https://github.com/KernelCode/kernelbot)

AI engineering agent — a Telegram bot backed by Claude with full OS control via tool use.

Send a message in Telegram, and KernelBot will read files, write code, run commands, browse the web, manage infrastructure, and respond with the results. It's your personal engineering assistant with direct access to your machine.

## Features

- **Autonomous agent loop** — send one message and KernelBot chains tool calls until the task is done, no hand-holding needed
- **Full shell access** — run any command, install packages, build projects, run tests
- **File management** — read, write, and create files with automatic directory creation
- **Web browsing** — navigate pages, extract content, take screenshots, interact with forms and buttons (Puppeteer)
- **Git workflow** — clone repos, create branches, commit, push, and view diffs
- **GitHub integration** — create repos, open PRs, post code reviews, list and inspect pull requests
- **JIRA integration** — read tickets, search with JQL, list assigned/project tickets (Cloud + Server)
- **Claude Code sub-agent** — spawn a dedicated Claude Code CLI session for complex coding tasks (write, edit, debug, refactor)
- **Docker management** — list containers, read logs, exec into containers, run compose commands
- **Process control** — list, kill, and manage system processes and systemd services
- **System monitoring** — check CPU, RAM, disk usage, and read system logs
- **Networking** — make HTTP requests, check ports, test and reload nginx
- **Send images** — share screenshots and files directly in the Telegram chat
- **Conversation memory** — per-chat history that persists across restarts
- **Live status updates** — Claude Code activity consolidated into a single updating message instead of spam
- **Security built-in** — user allowlist, blocked paths, dangerous operation confirmation, audit logging, secret redaction
- **Zero config setup** — auto-detects config, prompts for missing credentials on first run
- **Credential management** — auto-prompts for missing API keys (GitHub, Anthropic, Telegram, JIRA) and saves them

## How It Works

```text
You (Telegram) → KernelBot → Claude (Anthropic API)
                                   ↕
                      Tools (shell, files, git, docker, browser, etc.)
                                   ↕
                      Claude Code CLI (coding tasks)
```

KernelBot runs a **tool-use loop**: Claude decides which tools to call, KernelBot executes them on your OS, feeds results back, and Claude continues until the task is done. One message can trigger dozens of tool calls autonomously.

For complex coding tasks, KernelBot can spawn **Claude Code CLI** as a sub-agent — giving it a dedicated coding environment with its own tool loop for writing, editing, and debugging code.

## Tools

### File System & Shell

| Tool              | Description                                         |
| ----------------- | --------------------------------------------------- |
| `execute_command` | Run any shell command (git, npm, python, etc.)      |
| `read_file`       | Read file contents with optional line limits        |
| `write_file`      | Write/create files, auto-creates parent directories |
| `list_directory`  | List directory contents, optionally recursive       |

### Git & GitHub

| Tool                 | Description                                     |
| -------------------- | ----------------------------------------------- |
| `git_clone`          | Clone a repo (`org/repo` shorthand or full URL) |
| `git_checkout`       | Checkout or create branches                     |
| `git_commit`         | Stage all changes and commit                    |
| `git_push`           | Push current branch to remote                   |
| `git_diff`           | Show uncommitted changes                        |
| `github_create_pr`   | Create a pull request                           |
| `github_get_pr_diff` | Get the diff of a PR                            |
| `github_post_review` | Post a review on a PR                           |
| `github_create_repo` | Create a new GitHub repository                  |
| `github_list_prs`    | List pull requests for a repo                   |

### Web Browsing

| Tool                 | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| `browse_website`     | Navigate to a URL and extract page content (title, headings, text, links) |
| `screenshot_website` | Take a screenshot of a website, supports full-page and element capture    |
| `extract_content`    | Extract specific content using CSS selectors                              |
| `interact_with_page` | Click, type, scroll, and run JS on a webpage                              |
| `send_image`         | Send an image/screenshot directly to the Telegram chat                    |

### JIRA

| Tool                       | Description                               |
| -------------------------- | ----------------------------------------- |
| `jira_get_ticket`          | Get details of a specific JIRA ticket     |
| `jira_search_tickets`      | Search tickets using JQL queries          |
| `jira_list_my_tickets`     | List tickets assigned to the current user |
| `jira_get_project_tickets` | Get tickets from a specific JIRA project  |

### Docker

| Tool             | Description                                  |
| ---------------- | -------------------------------------------- |
| `docker_ps`      | List containers                              |
| `docker_logs`    | Get container logs                           |
| `docker_exec`    | Execute a command inside a running container |
| `docker_compose` | Run docker compose commands                  |

### Process & System

| Tool              | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `process_list`    | List running processes, optionally filter by name      |
| `kill_process`    | Kill a process by PID or name                          |
| `service_control` | Manage systemd services (start, stop, restart, status) |

### Monitoring

| Tool           | Description                     |
| -------------- | ------------------------------- |
| `disk_usage`   | Show disk space usage           |
| `memory_usage` | Show RAM usage                  |
| `cpu_usage`    | Show CPU load                   |
| `system_logs`  | Read system or application logs |

### Networking

| Tool           | Description                                |
| -------------- | ------------------------------------------ |
| `check_port`   | Check if a port is open and listening      |
| `curl_url`     | Make HTTP requests and return the response |
| `nginx_reload` | Test nginx config and reload if valid      |

### Coding

| Tool                | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `spawn_claude_code` | Spawn Claude Code CLI for coding tasks — writing, fixing, reviewing, and scaffolding code |

## Disclaimer

> **WARNING:** KernelBot has full access to your operating system. It can execute shell commands, read/write files, manage processes, control Docker containers, browse the web, and interact with external services (GitHub, Telegram) on your behalf. Only run KernelBot on machines you own and control. Always configure `allowed_users` in production to restrict who can interact with the bot. The authors are not responsible for any damage caused by misuse.

## Installation

```bash
npm install -g kernelbot
```

## Quick Start

```bash
kernelbot
```

That's it. On first run, KernelBot will:

1. Detect missing credentials and prompt for them
2. Save them to `~/.kernelbot/.env`
3. Verify API connections
4. Launch the Telegram bot

## Configuration

KernelBot auto-detects config from the current directory or `~/.kernelbot/`. Everything works with zero config — just provide your API keys when prompted.

### Environment Variables

Set these in `.env` or as system environment variables:

```text
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
GITHUB_TOKEN=ghp_...                           # optional, for GitHub tools
JIRA_BASE_URL=https://yourcompany.atlassian.net # optional, for JIRA tools
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-jira-api-token
```

### `config.yaml` (optional)

Drop a `config.yaml` in your working directory or `~/.kernelbot/` to customize behavior:

```yaml
bot:
  name: KernelBot

anthropic:
  model: claude-sonnet-4-20250514
  max_tokens: 8192
  temperature: 0.3
  max_tool_depth: 25 # max tool calls per message

telegram:
  allowed_users: [] # empty = allow all (dev mode)
  # allowed_users: [123456789]  # lock to specific Telegram user IDs

jira:
  base_url: https://yourcompany.atlassian.net
  email: you@company.com
  api_token: your-api-token

security:
  blocked_paths: # paths the agent cannot touch
    - /etc/shadow
    - /etc/passwd

claude_code:
  max_turns: 50
  timeout_seconds: 600
  # model: claude-sonnet-4-20250514  # optional model override

logging:
  level: info
  max_file_size: 5242880 # 5 MB

conversation:
  max_history: 50 # messages per chat
```

## Telegram Commands

| Command    | Description                        |
| ---------- | ---------------------------------- |
| `/clean`   | Clear conversation and start fresh |
| `/history` | Show message count in memory       |
| `/help`    | Show help message                  |

## Security

- **User allowlist** — restrict bot access to specific Telegram user IDs. Empty list = dev mode (anyone can use it).
- **Blocked paths** — files/directories the agent is forbidden from reading or writing (e.g., `/etc/shadow`, SSH keys).
- **Dangerous operation confirmation** — destructive actions require user confirmation before execution.
- **Browser URL blocklist** — internal/private network addresses are blocked from browsing.
- **Audit logging** — every tool call is logged to `kernel-audit.log` with user, tool, params, result, and duration. Secrets in params are automatically redacted.
- **Command timeout** — shell commands are killed after 30 seconds by default.

## JIRA Integration

KernelBot can read and search JIRA tickets. Supports both Atlassian Cloud (`*.atlassian.net`) and self-hosted JIRA Server instances.

### Setup

1. **Get an API token** — for Atlassian Cloud, generate one at [id.atlassian.net/manage-profile/security/api-tokens](https://id.atlassian.net/manage-profile/security/api-tokens). For JIRA Server, use your password or a personal access token.

2. **Configure** via environment variables or `config.yaml`:

```text
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-api-token
```

If credentials are missing when a JIRA tool is called, KernelBot will prompt for them via Telegram.

### Available Tools

- **`jira_get_ticket`** — Fetch a single ticket by key (e.g. `PROJ-123`). Returns summary, description, status, assignee, priority, and dates.
- **`jira_search_tickets`** — Search using JQL (e.g. `project = PROJ AND status = "In Progress"`). Returns up to `max_results` tickets.
- **`jira_list_my_tickets`** — List tickets assigned to the current user (or a specified assignee).
- **`jira_get_project_tickets`** — List all tickets in a project, ordered by last update.

## Project Structure

```text
KernelBot/
├── bin/
│   └── kernel.js              # Entry point + CLI menu
├── src/
│   ├── agent.js               # Claude tool-use loop
│   ├── bot.js                 # Telegram bot (polling, auth, message handling)
│   ├── coder.js               # Claude Code CLI spawner + smart output
│   ├── conversation.js        # Per-chat conversation history
│   ├── prompts/
│   │   └── system.js          # System prompt
│   ├── security/
│   │   ├── auth.js            # User allowlist
│   │   ├── audit.js           # Tool call audit logging
│   │   └── confirm.js         # Dangerous operation detection
│   ├── tools/
│   │   ├── os.js              # File system + shell tools
│   │   ├── git.js             # Git operations
│   │   ├── github.js          # GitHub API (PRs, repos, reviews)
│   │   ├── browser.js         # Web browsing (Puppeteer)
│   │   ├── docker.js          # Docker management
│   │   ├── process.js         # Process management
│   │   ├── monitor.js         # System monitoring (CPU, RAM, disk)
│   │   ├── network.js         # Network tools (HTTP, ports, nginx)
│   │   ├── coding.js          # Claude Code CLI handler
│   │   ├── jira.js            # JIRA ticket reading + search
│   │   └── index.js           # Tool registry + dispatcher
│   └── utils/
│       ├── config.js          # Config loading (auto-detect + prompt)
│       ├── display.js         # CLI display (logo, spinners, banners)
│       └── logger.js          # Winston logger
├── config.example.yaml
├── .env.example
└── package.json
```

## Requirements

- Node.js 18+
- [Anthropic API key](https://console.anthropic.com/)
- [Telegram Bot Token](https://t.me/BotFather)
- Chromium/Chrome (for browser tools — installed automatically by Puppeteer)
- [GitHub Token](https://github.com/settings/tokens) (optional, for GitHub tools)
- [JIRA API Token](https://id.atlassian.net/manage-profile/security/api-tokens) (optional, for JIRA integration)
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) (optional, for coding tasks)

## License

MIT

## Author

Abdullah Al-Taheri
