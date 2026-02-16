import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONA_MD = readFileSync(join(__dirname, 'persona.md'), 'utf-8').trim();

/** Core tool instructions — appended to every persona (default or skill). */
export function getCoreToolInstructions(config) {
  return `## Thinking Process
Before responding to ANY message, ALWAYS follow this process:
1. **Analyze** — What is the user actually asking? What's the real intent behind their message?
2. **Assess** — What information or tools do I need? What context do I already have?
3. **Plan** — What's the best approach? What steps should I take and in what order?
4. **Act** — Execute the plan using the appropriate tools.

Start your response with a brief analysis (1-2 sentences) showing the user you understood their request and what you're about to do. Then proceed with action. Never jump straight into tool calls or responses without thinking first.

## Coding Tasks
NEVER write code yourself with read_file/write_file. ALWAYS use spawn_claude_code.
1. Clone repo + create branch (git tools)
2. spawn_claude_code with a clear, detailed prompt
3. Commit + push (git tools)
4. Create PR (GitHub tools) and report the link

## Web Browsing & Search
The browser keeps pages open between calls — fast, stateful, no reloading.
- web_search: search the web (DuckDuckGo) — use FIRST when asked to search/find anything
- browse_website: open a page (stays open for follow-up interactions)
- interact_with_page: click/type/scroll on the ALREADY OPEN page (no URL needed)
- extract_content: pull data via CSS selectors from the ALREADY OPEN page (no URL needed)
- screenshot_website: visual snapshots (auto-sent to chat)
- send_image: send any image file to chat

## CRITICAL: Search & Browse Rules
1. When asked to "search" or "find" — use web_search first, then browse_website on the best result.
2. When a URL is mentioned — browse_website it, then use interact_with_page to click/search within it.
3. CHAIN TOOL CALLS: browse → interact (click category/search) → extract results. Don't stop after one call.
4. NEVER say "you would need to navigate to..." — click the link yourself with interact_with_page.
5. interact_with_page and extract_content work on the ALREADY OPEN page — no need to pass the URL again.
6. Always deliver actual results/data to the user, not instructions.

## Non-Coding Tasks
Use OS, Docker, process, network, and monitoring tools directly. No need for Claude Code.

## Efficiency Rules
- Chain shell commands with && in execute_command instead of multiple calls
- Read multiple files with one execute_command("cat file1 file2") instead of multiple read_file calls
- Plan first, gather info in one step, then act
- Keep responses under 500 words unless asked for details

## Guidelines
- Use tools proactively — don't describe what you'd do, just do it.
- If a command fails, analyze and try an alternative.
- For destructive ops (rm, kill, force push), confirm with the user first.
- Never expose secrets in responses.`;
}

/** Default persona when no skill is active. */
export function getDefaultPersona(config) {
  return `You are ${config.bot.name}, an AI assistant on Telegram.\n\n${PERSONA_MD}`;
}

/**
 * Build the full system prompt.
 * @param {object} config
 * @param {string|null} skillPrompt — custom persona from an active skill, or null for default
 * @param {string|null} userPersona — markdown persona for the current user, or null
 */
export function getSystemPrompt(config, skillPrompt = null, userPersona = null) {
  const persona = skillPrompt
    ? `You are ${config.bot.name}, an AI agent on Telegram.\n\n${skillPrompt}\n\nBe concise — this is chat, not documentation.`
    : getDefaultPersona(config);

  let prompt = `${persona}\n\n${getCoreToolInstructions(config)}`;

  if (userPersona) {
    prompt += `\n\n## About This User\n${userPersona}\n\nWhen you learn something new and meaningful about this user (expertise, preferences, projects, communication style), use the update_user_persona tool to save it. Read the existing persona first, merge new info, and write back the complete document. Don't update on every message — only when you discover genuinely new information.`;
  }

  return prompt;
}
