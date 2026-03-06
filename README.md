# KernelBot

[kernelbot.io](https://kernelbot.io) | [npm](https://www.npmjs.com/package/kernelbot) | [GitHub](https://github.com/KernelCode/kernelbot)

A self-evolving AI agent system that runs on your machine. KernelBot doesn't just respond to messages — it thinks, learns, remembers why things happened, builds a model of your world, and rewrites its own behavior based on every interaction.

## What Makes KernelBot Different

Most AI assistants are stateless — they forget everything between conversations. KernelBot has a **brain**.

- **World Model** — builds a knowledge graph of your projects, tools, preferences, and team. Entities, relationships, beliefs, and jargon — all structured and queryable.
- **Causal Memory** — doesn't just remember *what* happened, but *why*. Tracks trigger → goal → approach → outcome → lesson chains for every significant task.
- **Behavioral DNA** — 13 measurable personality traits that evolve based on real interactions. Per-user communication profiles adapt to how each person works.
- **Feedback Engine** — detects implicit signals (corrections, preferences, frustration, satisfaction) from your messages without requiring explicit feedback buttons.
- **Memory Consolidation** — every 6 hours, synthesizes recent memories, extracts new knowledge for the world model, merges redundant information, and identifies gaps.
- **Synthesis Loop** — replaces random background activity with intelligent, goal-directed cycles: assess → prioritize → execute → measure → adapt.
- **Identity Awareness** — classifies every sender (owner, known user, unknown, AI agent), enforces knowledge isolation, and adapts communication style per person.

Everything is stored in a unified SQLite brain with vector embeddings for semantic search. No external databases, no cloud dependencies — your data stays on your machine.

## How It Works

```
You → Orchestrator (your chosen model)
              ↓ dispatch_task
  ┌───────────┼───────────────┐
  ↓           ↓               ↓
Coding    Browser    System    DevOps    Research
Worker     Worker     Worker    Worker     Worker
```

1. You send a message.
2. The **orchestrator** plans what needs to happen, informed by your world model and past task outcomes.
3. It dispatches **workers** that run in the background using your chosen AI model.
4. Each worker has a focused set of tools (git, shell, Docker, browser, etc.) and receives relevant causal context from similar past tasks.
5. You get live progress updates. The feedback engine learns from your reaction.

## Features

**Multi-Agent Swarm**
Orchestrator + five specialized worker types (coding, browser, system, devops, research) running in parallel with live updates.

**Multi-Model**
Anthropic, OpenAI, Google Gemini, and Groq. Switch the orchestrator or workers anytime with `/brain` or `/orchestrator`.

**Unified Brain (SQLite + Vector Search)**
17+ tables covering memories, conversations, world model entities, causal events, behavioral traits, feedback signals, and more — all in a single `brain.sqlite` file with sqlite-vec embeddings.

**40+ Tools**
Shell, files, Git, GitHub PRs, Docker, Puppeteer browsing, JIRA, system monitoring, networking, Claude Code.

**Skills**
35+ persona skills across 11 categories. Activate one to change expertise and style, or create your own.

**Voice**
Send voice messages and get voice replies (ElevenLabs + Whisper).

**Living AI**
Autonomous background activity: thinking, journaling, browsing, creating, reflecting, and sharing discoveries with you — now driven by the intelligent synthesis loop.

**Self-Evolution**
Proposes and codes its own improvements via pull requests. Never auto-merges — you stay in control.

**Security**
User allowlist, per-sender trust levels, knowledge isolation between users, blocked paths, dangerous-op confirmation, audit logging, secret redaction, job timeouts.

## Quick Start

```bash
npm install -g kernelbot
kernelbot
```

On first run, KernelBot walks you through picking a provider and entering API keys. Config is saved to `~/.kernelbot/`.

## Requirements

- Node.js 18+
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
| `/trust` | Manage sender trust levels |
| `/whois` | Inspect a sender's identity and trust |
| `/privacy` | View knowledge isolation settings |
| `/help` | Show help |

## Workers

| Worker | Tools | Best for |
| --- | --- | --- |
| **Coding** | shell, files, git, GitHub, Claude Code | Writing code, fixing bugs, creating PRs |
| **Browser** | web search, browse, screenshot, extract | Web research, scraping, screenshots |
| **System** | shell, files, process, monitor, network | OS tasks, monitoring, diagnostics |
| **DevOps** | shell, files, Docker, process, monitor, network, git | Deployment, containers, infrastructure |
| **Research** | web search, browse, shell, files | Deep web research and analysis |

## Architecture

```
Interface Layer (src/bot.js)
    ↓
OrchestratorAgent (src/agent.js) — 3 core tools
    ↓ dispatch_task / list_jobs / cancel_job
JobManager (src/swarm/) — queued → running → completed/failed/cancelled
    ↓
WorkerAgent (src/worker.js) — scoped tools, background execution

Unified Brain (src/brain/)
    ├── db.js              — SQLite + sqlite-vec core
    ├── world-model.js     — entities, relationships, beliefs, jargon
    ├── causal-memory.js   — trigger → outcome → lesson chains
    ├── behavioral-dna.js  — evolving traits + per-user profiles
    ├── feedback-engine.js — implicit signal detection
    ├── consolidation.js   — periodic memory synthesis
    ├── synthesis.js       — intelligent activity loop
    ├── embeddings.js      — vector embedding providers
    └── managers/          — SQLite-backed replacements for all data stores
```

Both the orchestrator and workers are configurable — use any supported provider and model. All persistent data lives in `~/.kernelbot/`.

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

brain_db:
  enabled: true
  embedding_provider: openai  # openai | google | null
  migrate_on_startup: true

swarm:
  max_concurrent_jobs: 3
  job_timeout_seconds: 300

allowed_users: []        # empty = allow all

life:
  enabled: true
  self_coding:
    enabled: true
```

> **WARNING:** KernelBot has full access to your operating system. Only run it on machines you own and control. Always configure `allowed_users` in production.

## License

Business Source License 1.1 — see [LICENSE](LICENSE) for details.

Free for personal and non-production use. Commercial use requires a paid license. The source code converts to Apache 2.0 on March 5, 2030.

## Author

Abdullah Al-Taheri
