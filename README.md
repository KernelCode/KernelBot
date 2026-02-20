# KernelBot

[kernelbot.io](https://kernelbot.io) | [npm](https://www.npmjs.com/package/kernelbot) | [GitHub](https://github.com/KernelCode/kernelbot)

An AI-powered Telegram assistant that runs a multi-agent swarm on your machine. Send a message and KernelBot dispatches specialized AI workers that write code, run commands, open pull requests, manage servers, and browse the web — all in parallel, all from Telegram.

## How It Works

```text
You (Telegram) → Orchestrator (your chosen model)
                        ↓ dispatch_task
            ┌───────────┼───────────────┐
            ↓           ↓               ↓
     Coding      Browser      System      DevOps      Research
     Worker       Worker       Worker      Worker       Worker
```

1. You send a message on Telegram.
2. The **orchestrator** figures out what needs to happen.
3. It dispatches **workers** that run in the background using your chosen AI model.
4. Each worker has a focused set of tools (git, shell, Docker, browser, etc.).
5. You get live progress updates and a summary when the work is done.

## Features

- **Multi-agent swarm** — orchestrator + five worker types (coding, browser, system, devops, research) running in parallel.
- **Multi-model** — Anthropic, OpenAI, Google Gemini, and Groq. Switch anytime with `/brain` or `/orchestrator`.
- **40+ tools** — shell, files, Git, GitHub PRs, Docker, Puppeteer browsing, JIRA, system monitoring, networking, Claude Code.
- **Skills** — 35+ persona skills across 11 categories. Activate one to change expertise and style, or create your own.
- **Voice** — send voice messages and get voice replies (ElevenLabs + Whisper).
- **Memory** — conversation history, user personas, episodic and semantic memory that persist across restarts.
- **Living AI** — autonomous background activity: thinking, journaling, browsing, creating, reflecting, and sharing discoveries with you.
- **Self-awareness** — maintains its own identity (goals, journey, life, hobbies) that evolves over time.
- **Self-evolution** — proposes and codes its own improvements via PRs. Never auto-merges — you stay in control.
- **Automations** — recurring tasks on a schedule.
- **Security** — user allowlist, blocked paths, dangerous-op confirmation, audit logging, secret redaction, job timeouts.

## Quick Start

```bash
npm install -g kernelbot
kernelbot
```

On first run, KernelBot walks you through picking a provider, entering API keys, and setting up your Telegram bot token. Config is saved to `~/.kernelbot/`.

## Requirements

- Node.js 18+
- [Telegram Bot Token](https://t.me/BotFather)
- An API key for your chosen provider(s):
  [Anthropic](https://console.anthropic.com/) | [OpenAI](https://platform.openai.com/api-keys) | [Google AI](https://aistudio.google.com/apikey) | [Groq](https://console.groq.com/keys)
- Optional: [GitHub Token](https://github.com/settings/tokens), [JIRA API Token](https://id.atlassian.net/manage-profile/security/api-tokens), [ElevenLabs API Key](https://elevenlabs.io/), [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code)

## Commands

| Command | What it does |
| --- | --- |
| `/brain` | Switch the worker AI model |
| `/orchestrator` | Switch the orchestrator model |
| `/skills` | Browse and activate persona skills |
| `/jobs` | List running and recent jobs |
| `/cancel` | Cancel running job(s) |
| `/life` | Life engine status, pause/resume/trigger |
| `/journal` | Read journal entries |
| `/memories` | Browse or search memories |
| `/evolution` | Self-improvement proposals and history |
| `/auto` | Manage recurring automations |
| `/context` | Show conversation context |
| `/clean` | Clear conversation history |
| `/browse <url>` | Browse a website |
| `/help` | Show help |

## Workers

| Worker | Tools | Best for |
| --- | --- | --- |
| **Coding** | shell, files, git, GitHub, Claude Code | Writing code, fixing bugs, creating PRs |
| **Browser** | web search, browse, screenshot, extract | Web research, scraping, screenshots |
| **System** | shell, files, process, monitor, network | OS tasks, monitoring, diagnostics |
| **DevOps** | shell, files, Docker, process, monitor, network, git | Deployment, containers, infrastructure |
| **Research** | web search, browse, shell, files | Deep web research and analysis |

## Configuration

Config auto-detected from `./config.yaml` or `~/.kernelbot/config.yaml`. Environment variables go in `.env` or `~/.kernelbot/.env`.

```yaml
orchestrator:
  provider: anthropic    # anthropic | openai | google | groq
  model: claude-opus-4-6
  max_tokens: 8192

brain:
  provider: anthropic    # anthropic | openai | google | groq
  model: claude-sonnet-4-6
  max_tokens: 8192

swarm:
  max_concurrent_jobs: 3
  job_timeout_seconds: 300

telegram:
  allowed_users: []      # empty = allow all

life:
  enabled: true
  self_coding:
    enabled: true
```

See the [full config reference](https://github.com/KernelCode/kernelbot/blob/main/config.yaml) for all options.

## Architecture

```text
Telegram Bot (src/bot.js)
    ↓
OrchestratorAgent (src/agent.js) — 3 core tools
    ↓ dispatch_task / list_jobs / cancel_job
JobManager (src/swarm/) — queued → running → completed/failed/cancelled
    ↓
WorkerAgent (src/worker.js) — scoped tools, background execution
```

Both the orchestrator and workers are configurable — use any supported provider and model. All persistent data lives in `~/.kernelbot/`.

> **WARNING:** KernelBot has full access to your operating system. Only run it on machines you own and control. Always configure `allowed_users` in production.

## License

MIT

## Author

Abdullah Al-Taheri
