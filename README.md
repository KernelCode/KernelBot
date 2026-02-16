# KernelBot

[kernelbot.io](https://kernelbot.io) | [npm](https://www.npmjs.com/package/kernelbot) | [GitHub](https://github.com/KernelCode/kernelbot)

A multi-agent AI swarm — a Telegram bot with a smart orchestrator dispatching specialized workers powered by Claude, GPT, Gemini, or Groq with full OS control.

Send a message and KernelBot dispatches workers that write code, run commands, open PRs, manage Docker, and browse the web autonomously in parallel.

## How It Works

```text
You (Telegram) → Orchestrator (Claude Opus)
                        ↓ dispatch_task
            ┌───────────┼───────────────┐
            ↓           ↓               ↓
     💻 Coding    🌐 Browser    🖥️ System    🚀 DevOps    🔍 Research
      Worker       Worker        Worker       Worker       Worker
        ↕            ↕             ↕            ↕            ↕
   git, PRs,     web search,   shell, CPU,   Docker,     multi-source
  Claude Code    screenshots   RAM, disk    deploy, git   web research
```

KernelBot runs a **multi-agent swarm**. The **orchestrator** (always Claude Opus) understands your request and dispatches it to one or more **specialized workers** that run in parallel. Each worker has a scoped tool set and operates in the background using your chosen AI brain (Claude, GPT, Gemini, or Groq). The orchestrator coordinates, summarizes results, and keeps you informed.

## Features

- **Multi-agent swarm** — orchestrator dispatches tasks to specialized workers running in parallel
- **5 worker types** — coding, browser, system, devops, and research — each with scoped tools
- **Multi-model support** — workers use your chosen brain: Anthropic (Claude), OpenAI (GPT), Google (Gemini), or Groq (Llama/Mixtral). Switch anytime via `/brain`
- **Job management** — track, list, and cancel running workers with `/jobs` and `/cancel`
- **Full shell access** — run any command, install packages, build projects, run tests
- **File management** — read, write, and create files with automatic directory creation
- **Web browsing** — navigate pages, extract content, take screenshots, interact with forms and buttons (Puppeteer)
- **Web search** — search the web and synthesize results from multiple sources
- **Git workflow** — clone repos, create branches, commit, push, and view diffs
- **GitHub integration** — create repos, open PRs, post code reviews, list and inspect pull requests
- **JIRA integration** — read tickets, search with JQL, list assigned/project tickets (Cloud + Server)
- **Claude Code sub-agent** — spawn a dedicated Claude Code CLI session for complex coding tasks (write, edit, debug, refactor)
- **Docker management** — list containers, read logs, exec into containers, run compose commands
- **Process control** — list, kill, and manage system processes and systemd services
- **System monitoring** — check CPU, RAM, disk usage, and read system logs
- **Networking** — make HTTP requests, check ports, test and reload nginx
- **Send images** — share screenshots and files directly in the Telegram chat
- **Skills system** — 35+ built-in persona skills across 11 categories (engineering, design, marketing, etc.) plus custom skills you create
- **User personas** — auto-learns your preferences, expertise, and communication style across conversations
- **Smart progress** — live-updating Telegram messages show each worker's activity in real time
- **Conversation memory** — per-chat history with summarization that persists across restarts
- **Security built-in** — user allowlist, blocked paths, dangerous operation confirmation, audit logging, secret redaction
- **Zero config setup** — auto-detects config, prompts for missing credentials on first run

## Worker Types

| Worker | Tools | Use Case |
| --- | --- | --- |
| **Coding** | shell, files, git, GitHub, Claude Code | Write code, fix bugs, create PRs |
| **Browser** | web search, browse, screenshot, extract, interact | Web search, scraping, screenshots |
| **System** | shell, files, process, monitor, network | OS operations, monitoring, diagnostics |
| **DevOps** | shell, files, Docker, process, monitor, network, git | Docker, deploy, infrastructure |
| **Research** | web search, browse, shell, files | Deep web research and analysis |

The orchestrator picks the right worker (or multiple workers in parallel) based on your request. You can also run `/jobs` to see what's running and `/cancel` to stop any worker.

## Tools

### File System & Shell

| Tool | Description |
| --- | --- |
| `execute_command` | Run any shell command (git, npm, python, etc.) |
| `read_file` | Read file contents with optional line limits |
| `write_file` | Write/create files, auto-creates parent directories |
| `list_directory` | List directory contents, optionally recursive |

### Git & GitHub

| Tool | Description |
| --- | --- |
| `git_clone` | Clone a repo (`org/repo` shorthand or full URL) |
| `git_checkout` | Checkout or create branches |
| `git_commit` | Stage all changes and commit |
| `git_push` | Push current branch to remote |
| `git_diff` | Show uncommitted changes |
| `github_create_pr` | Create a pull request |
| `github_get_pr_diff` | Get the diff of a PR |
| `github_post_review` | Post a review on a PR |
| `github_create_repo` | Create a new GitHub repository |
| `github_list_prs` | List pull requests for a repo |

### Web Browsing & Search

| Tool | Description |
| --- | --- |
| `web_search` | Search the web and return results |
| `browse_website` | Navigate to a URL and extract page content (title, headings, text, links) |
| `screenshot_website` | Take a screenshot of a website, supports full-page and element capture |
| `extract_content` | Extract specific content using CSS selectors |
| `interact_with_page` | Click, type, scroll, and run JS on a webpage |
| `send_image` | Send an image/screenshot directly to the Telegram chat |

### JIRA

| Tool | Description |
| --- | --- |
| `jira_get_ticket` | Get details of a specific JIRA ticket |
| `jira_search_tickets` | Search tickets using JQL queries |
| `jira_list_my_tickets` | List tickets assigned to the current user |
| `jira_get_project_tickets` | Get tickets from a specific JIRA project |

### Docker

| Tool | Description |
| --- | --- |
| `docker_ps` | List containers |
| `docker_logs` | Get container logs |
| `docker_exec` | Execute a command inside a running container |
| `docker_compose` | Run docker compose commands |

### Process & System

| Tool | Description |
| --- | --- |
| `process_list` | List running processes, optionally filter by name |
| `kill_process` | Kill a process by PID or name |
| `service_control` | Manage systemd services (start, stop, restart, status) |

### Monitoring

| Tool | Description |
| --- | --- |
| `disk_usage` | Show disk space usage |
| `memory_usage` | Show RAM usage |
| `cpu_usage` | Show CPU load |
| `system_logs` | Read system or application logs |

### Networking

| Tool | Description |
| --- | --- |
| `check_port` | Check if a port is open and listening |
| `curl_url` | Make HTTP requests and return the response |
| `nginx_reload` | Test nginx config and reload if valid |

### Coding

| Tool | Description |
| --- | --- |
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

1. Prompt you to select an AI provider and model
2. Ask for your API key and Telegram bot token
3. Save credentials to `~/.kernelbot/.env`
4. Verify API connections
5. Launch the Telegram bot

You can change your AI provider/model anytime from the CLI menu (option 5) or via the `/brain` command in Telegram.

## Configuration

KernelBot auto-detects config from the current directory or `~/.kernelbot/`. Everything works with zero config — just provide your API keys when prompted.

### Environment Variables

Set these in `.env` or as system environment variables:

```text
# Required — Anthropic key is always needed (orchestrator runs on Claude)
ANTHROPIC_API_KEY=sk-ant-...

# Worker brain key (only the one matching your chosen provider is required)
OPENAI_API_KEY=sk-...            # for OpenAI (GPT)
GOOGLE_API_KEY=AIza...           # for Google (Gemini)
GROQ_API_KEY=gsk_...             # for Groq (Llama/Mixtral)

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

# Orchestrator — always Anthropic (Claude), manages the swarm
orchestrator:
  model: claude-opus-4-0-20250514
  max_tokens: 8192
  temperature: 0.3
  max_tool_depth: 15

# Worker brain — your choice of provider/model for all workers
brain:
  provider: anthropic    # anthropic | openai | google | groq
  model: claude-sonnet-4-20250514
  max_tokens: 8192
  temperature: 0.3

# Swarm settings
swarm:
  max_concurrent_jobs: 3
  job_timeout_seconds: 300
  cleanup_interval_minutes: 30

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

| Command | Description |
| --- | --- |
| `/brain` | Show current AI model and switch provider/model |
| `/skills` | Browse and activate persona skills |
| `/skills reset` | Clear active skill back to default |
| `/jobs` | List running and recent jobs |
| `/cancel` | Cancel running job(s) |
| `/context` | Show conversation context and brain info |
| `/clean` | Clear conversation and start fresh |
| `/history` | Show message count in memory |
| `/browse <url>` | Browse a website and get a summary |
| `/screenshot <url>` | Take a screenshot of a website |
| `/extract <url> <selector>` | Extract content using CSS selector |
| `/help` | Show help message |

## Skills

KernelBot comes with **35+ built-in persona skills** across 11 categories that change the agent's expertise and communication style. Use `/skills` to browse and activate them.

| Category | Examples |
| --- | --- |
| Engineering | Sr. Frontend, Sr. Backend, DevOps, Mobile, Security, Data Engineer |
| Design | UI/UX Designer, Graphic Designer, Product Designer |
| Marketing | Content Marketer, SEO Specialist, Growth Hacker, Social Media |
| Business | Product Manager, Business Analyst, Startup Advisor, Project Manager |
| Writing | Technical Writer, Copywriter, Creative Writer, Academic Writer |
| Data & AI | Data Scientist, ML Engineer, BI Analyst |
| Finance | Financial Analyst, Accountant, Crypto & DeFi Advisor |
| Legal | Legal Advisor, Contract Reviewer |
| Education | Tutor, Curriculum Designer, Language Teacher |
| Healthcare | Medical Researcher, Health & Wellness Advisor |
| Creative | Video Producer, Music Producer, Photographer |

You can also create **custom skills** with your own system prompts — type or upload a `.md` file via the `/skills` menu.

## Security

- **User allowlist** — restrict bot access to specific Telegram user IDs. Empty list = dev mode (anyone can use it).
- **Blocked paths** — files/directories the agent is forbidden from reading or writing (e.g., `/etc/shadow`, SSH keys).
- **Dangerous operation confirmation** — destructive actions require user confirmation before execution.
- **Browser URL blocklist** — internal/private network addresses are blocked from browsing.
- **Audit logging** — every tool call is logged to `kernel-audit.log` with user, tool, params, result, and duration. Secrets in params are automatically redacted.
- **Command timeout** — shell commands are killed after 30 seconds by default.
- **Job timeout** — workers are automatically terminated after configurable timeout (default 300s).
- **Circuit breaker** — workers that fail 3 consecutive tool call iterations are stopped to prevent runaway loops.

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

## Project Structure

```text
KernelBot/
├── bin/
│   └── kernel.js                  # Entry point + CLI menu
├── src/
│   ├── agent.js                   # OrchestratorAgent — swarm brain, job lifecycle, worker spawning
│   ├── worker.js                  # WorkerAgent — scoped agent loop, cancellation, circuit breaker
│   ├── bot.js                     # Telegram bot (polling, auth, commands, batching)
│   ├── coder.js                   # Claude Code CLI spawner + smart output
│   ├── conversation.js            # Per-chat conversation history + summarization
│   ├── persona.js                 # UserPersonaManager — auto-learning user profiles
│   ├── intents/
│   │   ├── detector.js            # Web search/browse intent detection
│   │   └── planner.js             # Execution plan generation for intents
│   ├── prompts/
│   │   ├── orchestrator.js        # Orchestrator system prompt
│   │   ├── workers.js             # Per-worker-type system prompts
│   │   └── system.js              # Core tool instructions
│   ├── providers/
│   │   ├── models.js              # Provider & model catalog
│   │   ├── base.js                # Abstract provider interface
│   │   ├── anthropic.js           # Anthropic (Claude) provider
│   │   ├── openai-compat.js       # OpenAI / Gemini / Groq provider
│   │   └── index.js               # Provider factory
│   ├── security/
│   │   ├── auth.js                # User allowlist
│   │   ├── audit.js               # Tool call audit logging
│   │   └── confirm.js             # Dangerous operation detection
│   ├── skills/
│   │   ├── catalog.js             # 35+ built-in persona skills
│   │   └── custom.js              # Custom skill CRUD + unified lookups
│   ├── swarm/
│   │   ├── job.js                 # Job class (state machine, transitions, summary)
│   │   ├── job-manager.js         # JobManager (EventEmitter, CRUD, cleanup, timeouts)
│   │   └── worker-registry.js     # Worker type → tool category mapping
│   ├── tools/
│   │   ├── categories.js          # Tool category definitions + keyword matching
│   │   ├── orchestrator-tools.js  # dispatch_task, list_jobs, cancel_job
│   │   ├── os.js                  # File system + shell tools
│   │   ├── git.js                 # Git operations
│   │   ├── github.js              # GitHub API (PRs, repos, reviews)
│   │   ├── browser.js             # Web browsing + search (Puppeteer)
│   │   ├── docker.js              # Docker management
│   │   ├── process.js             # Process management
│   │   ├── monitor.js             # System monitoring (CPU, RAM, disk)
│   │   ├── network.js             # Network tools (HTTP, ports, nginx)
│   │   ├── coding.js              # Claude Code CLI handler
│   │   ├── jira.js                # JIRA ticket reading + search
│   │   ├── persona.js             # User persona update tool
│   │   └── index.js               # Tool registry + dispatcher
│   └── utils/
│       ├── config.js              # Config loading (auto-detect + prompt)
│       ├── display.js             # CLI display (logo, spinners, banners)
│       └── logger.js              # Winston logger
├── config.example.yaml
├── .env.example
└── package.json
```

## Requirements

- Node.js 18+
- [Anthropic API key](https://console.anthropic.com/) — always required (orchestrator runs on Claude)
- [Telegram Bot Token](https://t.me/BotFather)
- Chromium/Chrome (for browser tools — installed automatically by Puppeteer)
- Worker brain API key (optional if using Anthropic for workers too):
  - [OpenAI API key](https://platform.openai.com/api-keys) (GPT)
  - [Google AI API key](https://aistudio.google.com/apikey) (Gemini)
  - [Groq API key](https://console.groq.com/keys) (Llama/Mixtral)
- [GitHub Token](https://github.com/settings/tokens) (optional, for GitHub tools)
- [JIRA API Token](https://id.atlassian.net/manage-profile/security/api-tokens) (optional, for JIRA integration)
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) (optional, for coding tasks)

## License

MIT

## Author

Abdullah Al-Taheri
