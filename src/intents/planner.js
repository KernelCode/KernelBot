/**
 * Task planner — generates structured execution plans for detected intents.
 *
 * The plan is injected into the user message BEFORE the model sees it,
 * so the model follows a clear step-by-step procedure instead of deciding
 * on its own when to stop.
 */

const PLANS = {
  search: (message) =>
    `[EXECUTION PLAN — Complete ALL steps before responding]

TASK: Search the web and deliver results.

STEP 1 — SEARCH: Use web_search("relevant query"). If a specific website is mentioned in the request, also use browse_website to open it directly.
STEP 2 — OPEN: Use browse_website to open the most relevant result URL.
STEP 3 — GO DEEPER: The page is now open. Use interact_with_page (no URL needed) to click into relevant sections, categories, or use search bars within the site.
STEP 4 — EXTRACT: Read the page content from the tool response. Use extract_content if you need structured data.
STEP 5 — PRESENT: Share the actual results, listings, or data with the user.

RULES:
- You MUST reach at least STEP 3 before writing any response to the user.
- Do NOT ask the user questions or offer choices — complete the full task.
- Do NOT explain what you can't do — try alternative approaches.
- If one page doesn't have results, try a different URL or search query.
- After interact_with_page clicks a link, the page navigates automatically — read the returned content.

USER REQUEST: ${message}`,

  browse: (message) =>
    `[EXECUTION PLAN — Complete ALL steps before responding]

TASK: Browse a website and extract the requested information.

STEP 1 — OPEN: Use browse_website to open the mentioned site.
STEP 2 — NAVIGATE: The page is open. Use interact_with_page (no URL needed) to click relevant links, sections, categories, or use search bars.
STEP 3 — EXTRACT: Read the page content. Use extract_content for structured data if needed.
STEP 4 — PRESENT: Share the actual findings with the user.

RULES:
- Do NOT stop at the homepage — navigate into relevant sections.
- Do NOT ask the user what to do — figure it out from the page links and complete the task.
- After interact_with_page clicks a link, the page navigates automatically — read the returned content.

USER REQUEST: ${message}`,
};

/**
 * Generate an execution plan for a detected intent.
 *
 * @param {{ type: string, message: string }} intent
 * @returns {string|null} — planned message, or null if no plan needed
 */
export function generatePlan(intent) {
  const generator = PLANS[intent.type];
  if (!generator) return null;
  return generator(intent.message);
}
