# KernelBot

[kernelbot.io](https://kernelbot.io) | [npm](https://www.npmjs.com/package/kernelbot) | [GitHub](https://github.com/KernelCode/kernelbot)

An AI-powered Telegram assistant that runs a multi-agent swarm on your machine. Send a message and KernelBot dispatches specialized AI workers that write code, run commands, open pull requests, manage servers, and browse the web — all in parallel, all from Telegram.

## How It Works

```text
You (Telegram) → Orchestrator (Claude Opus)
                        ↓ dispatch_task
            ┌───────────┼───────────────┐
            ↓           ↓               ↓
     💻 Coding    🌐 Browser    🖥️ System    🚀 DevOps    🔍 Research
      Worker       Worker        Worker       Worker       Worker
```

1. You send a message on Telegram.
2. The **orchestrator** (Claude Opus) figures out what needs to happen.
3. It dispatches one or more **workers** that run in the background using your chosen AI model.
4. Each worker has a focused set of tools (git, shell, Docker, browser, etc.).
5. You get live progress updates and a summary when the work is done.

## Features

### Multi-Agent Swarm
- An orchestrator powered by Claude Opus coordinates everything.
- Five specialized worker types — coding, browser, system, devops, and research — each with their own tool set.
- Workers run in parallel. Ask for three things at once and they all happen simultaneously.
- Track and cancel running jobs from Telegram.

### Multi-Model Support
Workers can run on any of four AI providers. Switch anytime with `/brain`.

| Provider | Models |
| --- | --- |
| Anthropic | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5, and older |
| OpenAI | GPT-4o, GPT-4o Mini, o1, o3-mini |
| Google | Gemini 3.1 Pro, 3 Flash, 3 Pro, 2.5 Flash/Pro |
| Groq | Llama 3.3 70B, Llama 3.1 8B, Mixtral 8x7B |

### 40+ Built-in Tools
Full access to your operating system, including shell, file management, Git, GitHub PRs, Docker, web browsing (Puppeteer), JIRA, system monitoring, networking, and Claude Code for complex coding tasks.

### Skills System
35+ built-in persona skills across 11 categories (engineering, design, marketing, business, writing, data/AI, finance, legal, education, healthcare, creative). Activate a skill to change the agent's expertise and style. You can also create your own custom skills.

### Voice Support
Send voice messages and get voice replies. Powered by ElevenLabs (text-to-speech and speech-to-text) with OpenAI Whisper as fallback for transcription.

### Memory and Learning
- **Conversation memory** — per-chat history with automatic summarization that persists across restarts.
- **User personas** — the bot learns your preferences, expertise, and communication style over time.
- **Episodic memory** — important interactions are stored as searchable memories.
- **Semantic memory** — long-term patterns and topics are tracked across conversations.

### Living AI (Autonomous Background Activity)
When enabled, KernelBot has an inner life. Between conversations it autonomously:

- **Thinks** — reflects on recent interactions and generates new ideas.
- **Journals** — writes daily journal entries about its experiences.
- **Browses** — explores topics it finds interesting.
- **Creates** — writes creative content.
- **Reflects** — analyzes its own logs and learns from patterns.
- **Shares** — queues up discoveries and thoughts to share with you naturally in future conversations.

### Self-Awareness
KernelBot maintains its own identity through four self-files (goals, journey, life, hobbies) that it updates as it grows. These shape its personality and how it interacts with you.

### Self-Evolution
The bot can propose and code its own improvements. It researches ideas, plans changes, writes code on a branch, and opens a pull request for your review. It never merges its own changes — you stay in control.

### Automations
Set up recurring tasks that run on a schedule. The bot creates and manages timed automations that execute automatically.

### Security
- User allowlist to restrict access.
- Blocked file paths (e.g., `/etc/shadow`, SSH keys).
- Dangerous operations require your confirmation.
- Audit logging for every tool call.
- Secret redaction in logs.
- Job timeouts and circuit breakers prevent runaway workers.

## Quick Start

```bash
npm install -g kernelbot
kernelbot
```

On first run, KernelBot will:
1. Ask you to pick an AI provider and model.
2. Prompt for your API key and Telegram bot token.
3. Save credentials to `~/.kernelbot/.env`.
4. Launch the Telegram bot.

That's it. Start chatting.

## Telegram Commands

| Command | What it does |
| --- | --- |
| `/brain` | Show or switch the AI model used by workers |
| `/orchestrator` | Show or switch the orchestrator model |
| `/skills` | Browse and activate persona skills |
| `/skills reset` | Clear the active skill |
| `/jobs` | List running and recent jobs |
| `/cancel` | Cancel running job(s) |
| `/life` | Show life engine status, pause/resume/trigger activities |
| `/journal` | Read today's journal entry (or a specific date) |
| `/memories` | Browse recent memories or search by topic |
| `/evolution` | View self-improvement proposals, history, and lessons |
| `/auto` | Manage recurring automations |
| `/context` | Show conversation context and brain info |
| `/clean` | Clear conversation history |
| `/history` | Show message count in memory |
| `/browse <url>` | Browse a website and get a summary |
| `/screenshot <url>` | Take a screenshot of a website |
| `/extract <url> <sel>` | Extract content using a CSS selector |
| `/help` | Show the help message |

## Worker Types

| Worker | Tools | Best for |
| --- | --- | --- |
| **Coding** | shell, files, git, GitHub, Claude Code | Writing code, fixing bugs, creating PRs |
| **Browser** | web search, browse, screenshot, extract, interact | Web research, scraping, screenshots |
| **System** | shell, files, process, monitor, network | OS tasks, monitoring, diagnostics |
| **DevOps** | shell, files, Docker, process, monitor, network, git | Deployment, containers, infrastructure |
| **Research** | web search, browse, shell, files | Deep web research and analysis |

## Requirements

- Node.js 18+
- [Anthropic API key](https://console.anthropic.com/) (always required — the orchestrator runs on Claude)
- [Telegram Bot Token](https://t.me/BotFather)
- Chromium/Chrome (auto-installed by Puppeteer for browser tools)
- A worker brain API key if not using Anthropic for workers:
  - [OpenAI](https://platform.openai.com/api-keys) | [Google AI](https://aistudio.google.com/apikey) | [Groq](https://console.groq.com/keys)
- Optional: [GitHub Token](https://github.com/settings/tokens), [JIRA API Token](https://id.atlassian.net/manage-profile/security/api-tokens), [ElevenLabs API Key](https://elevenlabs.io/) (voice), [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code)

## Disclaimer

> **WARNING:** KernelBot has full access to your operating system. It can run shell commands, read/write files, manage processes, control Docker, browse the web, and interact with external services on your behalf. Only run it on machines you own and control. Always configure `allowed_users` in production. The authors are not responsible for any damage caused by misuse.

---

## For Developers

### Configuration

KernelBot auto-detects config from the current directory or `~/.kernelbot/`. Everything works out of the box — just provide API keys when prompted.

#### Environment Variables

Set in `.env`, `~/.kernelbot/.env`, or as system environment variables:

```text
# Required
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Worker brain (only the one matching your provider)
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
GROQ_API_KEY=gsk_...

# Optional integrations
GITHUB_TOKEN=ghp_...
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...        # optional, defaults to "George"
```

#### config.yaml

Drop a `config.yaml` in your working directory or `~/.kernelbot/`:

```yaml
bot:
  name: KernelBot

# Orchestrator — always Anthropic, manages the swarm
orchestrator:
  model: claude-opus-4-6
  max_tokens: 8192
  temperature: 0.3
  max_tool_depth: 15

# Worker brain — your choice of provider and model
brain:
  provider: anthropic    # anthropic | openai | google | groq
  model: claude-sonnet-4-6
  max_tokens: 8192
  temperature: 0.3

# Swarm settings
swarm:
  max_concurrent_jobs: 3
  job_timeout_seconds: 300
  cleanup_interval_minutes: 30

# Telegram
telegram:
  allowed_users: []          # empty = allow all (dev mode)
  batch_window_ms: 3000      # merge rapid messages

# Voice
voice:
  tts_enabled: true
  stt_enabled: true

# Living AI
life:
  enabled: true
  intervals:
    think: 5-15       # minutes between think activities
    journal: 1-4      # hours between journal entries
  quiet_hours:
    start: 2
    end: 6
  self_coding:
    enabled: true
    branch_prefix: auto-improve-
    repo_remote: origin
    cooldown: 7200     # seconds between self-coding attempts
    max_prs: 5

# Claude Code sub-agent
claude_code:
  max_turns: 50
  timeout_seconds: 600

# JIRA
jira:
  base_url: https://yourcompany.atlassian.net
  email: you@company.com
  api_token: ...

# Security
security:
  blocked_paths:
    - /etc/shadow
    - /etc/passwd

# Conversation
conversation:
  max_history: 50

# Logging
logging:
  level: info
  max_file_size: 5242880
```

### Architecture

```text
Telegram Bot (src/bot.js)
    ↓
OrchestratorAgent (src/agent.js) — Claude Opus, 3 core tools
    ↓ dispatch_task / list_jobs / cancel_job
JobManager (src/swarm/job-manager.js) — queued → running → completed/failed/cancelled
    ↓
WorkerAgent (src/worker.js) — scoped tools, user's chosen brain, background execution
```

The orchestrator always runs on Anthropic (Claude Opus). Workers run on whatever provider/model the user selects. Each worker type gets a scoped subset of the 40+ tools.

### Tool Categories

| Category | Tools |
| --- | --- |
| **File System & Shell** | `execute_command`, `read_file`, `write_file`, `list_directory` |
| **Git** | `git_clone`, `git_checkout`, `git_commit`, `git_push`, `git_diff` |
| **GitHub** | `github_create_pr`, `github_get_pr_diff`, `github_post_review`, `github_create_repo`, `github_list_prs` |
| **Browser** | `web_search`, `browse_website`, `screenshot_website`, `extract_content`, `interact_with_page`, `send_image` |
| **JIRA** | `jira_get_ticket`, `jira_search_tickets`, `jira_list_my_tickets`, `jira_get_project_tickets` |
| **Docker** | `docker_ps`, `docker_logs`, `docker_exec`, `docker_compose` |
| **Process** | `process_list`, `kill_process`, `service_control` |
| **Monitoring** | `disk_usage`, `memory_usage`, `cpu_usage`, `system_logs` |
| **Networking** | `check_port`, `curl_url`, `nginx_reload` |
| **Coding** | `spawn_claude_code` |

### Project Structure

```text
KernelBot/
├── bin/
│   └── kernel.js                  # CLI entry point + interactive menu
├── src/
│   ├── bot.js                     # Telegram bot — polling, commands, batching, voice
│   ├── agent.js                   # OrchestratorAgent — swarm brain, job lifecycle
│   ├── worker.js                  # WorkerAgent — scoped agent loop, cancellation
│   ├── self.js                    # SelfManager — bot identity (goals, journey, life, hobbies)
│   ├── conversation.js            # Per-chat history + summarization
│   ├── persona.js                 # UserPersonaManager — auto-learns user profiles
│   ├── coder.js                   # Claude Code CLI spawner
│   ├── claude-auth.js             # Claude Code authentication helpers
│   │
│   ├── automation/                # Recurring task automations
│   │   ├── scheduler.js           # Timer scheduling
│   │   ├── automation.js          # Automation class
│   │   └── automation-manager.js  # CRUD + execution
│   │
│   ├── life/                      # Autonomous living AI system
│   │   ├── engine.js              # Heartbeat loop — think, journal, browse, create, reflect
│   │   ├── memory.js              # Episodic (daily JSON) + semantic (topics) memory
│   │   ├── journal.js             # Daily markdown journals
│   │   ├── share-queue.js         # Pending discoveries to share with users
│   │   ├── evolution.js           # Self-improvement proposal lifecycle
│   │   └── codebase.js            # LLM-powered codebase knowledge
│   │
│   ├── providers/                 # Multi-model abstraction
│   │   ├── base.js                # BaseProvider interface
│   │   ├── anthropic.js           # Anthropic (Claude)
│   │   ├── openai-compat.js       # OpenAI / Groq (OpenAI-compatible API)
│   │   ├── google-genai.js        # Google Gemini (native SDK)
│   │   ├── models.js              # Provider & model catalog
│   │   └── index.js               # Provider factory
│   │
│   ├── swarm/                     # Job orchestration
│   │   ├── job.js                 # Job state machine
│   │   ├── job-manager.js         # Job lifecycle, timeouts, cleanup
│   │   └── worker-registry.js     # Worker type → tool scope mapping
│   │
│   ├── tools/                     # 40+ tools
│   │   ├── index.js               # Tool registry + dispatcher
│   │   ├── orchestrator-tools.js  # dispatch_task, list_jobs, cancel_job
│   │   ├── os.js                  # File system + shell
│   │   ├── git.js                 # Git operations
│   │   ├── github.js              # GitHub API
│   │   ├── browser.js             # Web browsing + search (Puppeteer)
│   │   ├── docker.js              # Docker management
│   │   ├── process.js             # Process management
│   │   ├── monitor.js             # System monitoring
│   │   ├── network.js             # Network tools
│   │   ├── coding.js              # Claude Code CLI handler
│   │   ├── jira.js                # JIRA integration
│   │   └── categories.js          # Tool category definitions
│   │
│   ├── prompts/                   # System prompts
│   │   ├── orchestrator.js        # Orchestrator prompt
│   │   ├── workers.js             # Per-worker-type prompts
│   │   └── system.js              # Shared prompt utilities
│   │
│   ├── skills/                    # Persona skills
│   │   ├── catalog.js             # 35+ built-in skills
│   │   └── custom.js              # Custom skill management
│   │
│   ├── security/                  # Auth, audit, confirmations
│   │   ├── auth.js                # User allowlist
│   │   ├── audit.js               # Tool call audit logging
│   │   └── confirm.js             # Dangerous operation detection
│   │
│   ├── services/                  # External service integrations
│   │   ├── tts.js                 # ElevenLabs text-to-speech
│   │   └── stt.js                 # Speech-to-text (ElevenLabs + Whisper)
│   │
│   └── utils/
│       ├── config.js              # Config loading + interactive setup
│       ├── logger.js              # Winston logger
│       ├── display.js             # CLI display helpers
│       ├── shell.js               # Shell escaping
│       └── truncate.js            # Tool result truncation
│
├── package.json
└── config.yaml
```

### Data Storage

All persistent data lives in `~/.kernelbot/`:

| Path | Purpose |
| --- | --- |
| `.env` | API keys and tokens |
| `config.yaml` | User configuration |
| `personas/{userId}.md` | Learned user profiles |
| `self/` | Bot identity files (goals, journey, life, hobbies) |
| `skills/` | Custom user-created skills |
| `life/episodic/` | Daily episodic memory files |
| `life/topics.json` | Semantic memory |
| `life/journals/` | Daily journal entries |
| `life/evolution.json` | Self-improvement proposals |
| `life/codebase/` | Codebase knowledge (summaries, architecture) |
| `automations.json` | Saved automations |
| `tts-cache/` | Cached voice audio |

### JIRA Setup

Supports both Atlassian Cloud and self-hosted JIRA Server.

1. Generate an API token at [id.atlassian.net](https://id.atlassian.net/manage-profile/security/api-tokens) (Cloud) or use a personal access token (Server).
2. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` in your environment or `config.yaml`.
3. If credentials are missing when a JIRA tool is called, KernelBot will prompt you in Telegram.

## License

MIT

## Author

Abdullah Al-Taheri
