import puppeteer from 'puppeteer';
import { writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ── Constants ────────────────────────────────────────────────────────────────

const NAVIGATION_TIMEOUT = 30000;
const MAX_CONTENT_LENGTH = 15000;
const MAX_SCREENSHOT_WIDTH = 1920;
const MAX_SCREENSHOT_HEIGHT = 1080;
const SCREENSHOTS_DIR = join(homedir(), '.kernelbot', 'screenshots');

// Blocklist to prevent abuse — internal/private network ranges and sensitive targets
const BLOCKED_URL_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/169\.254\./,
  /^file:/i,
  /^ftp:/i,
  /^data:/i,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  // Block non-http protocols before auto-prepending https
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      return { valid: false, error: 'Access to internal/private network addresses or non-HTTP protocols is blocked' };
    }
  }

  // Add https:// if no protocol specified
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check again after normalization (e.g., localhost without protocol)
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      return { valid: false, error: 'Access to internal/private network addresses is blocked' };
    }
  }

  return { valid: true, url };
}

function truncate(text, maxLength = MAX_CONTENT_LENGTH) {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n... [truncated, ${text.length - maxLength} chars omitted]`;
}

async function ensureScreenshotsDir() {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
}

async function withBrowser(fn) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
      ],
    });
    return await fn(browser);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function navigateTo(page, url, waitUntil = 'networkidle2') {
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: MAX_SCREENSHOT_WIDTH, height: MAX_SCREENSHOT_HEIGHT });
  await page.goto(url, {
    waitUntil,
    timeout: NAVIGATION_TIMEOUT,
  });
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const definitions = [
  {
    name: 'web_search',
    description:
      'Search the web using DuckDuckGo and return a list of results with titles, snippets, and URLs. Use this FIRST when asked to search, find, or look up anything on the web. Then use browse_website to visit specific result URLs for details.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "top cars haraj market", "best restaurants in dubai")',
        },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default: 8, max: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_website',
    description:
      'Navigate to a website URL and extract its content including title, headings, text, links, and metadata. Returns a structured summary of the page with navigation links. Handles JavaScript-rendered pages. After browsing, use the returned links to navigate deeper if needed.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to browse (e.g., "https://example.com" or "example.com")',
        },
        wait_for_selector: {
          type: 'string',
          description: 'Optional CSS selector to wait for before extracting content (useful for JS-heavy pages)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'screenshot_website',
    description:
      'Take a screenshot of a website and save it to disk. Returns the file path to the screenshot image. Supports full-page and viewport-only screenshots.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to screenshot',
        },
        full_page: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of just the viewport (default: false)',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector to screenshot a specific element instead of the full page',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'extract_content',
    description:
      'Extract specific content from a webpage using CSS selectors. Returns the text or HTML content of matched elements. Useful for scraping structured data.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to extract content from',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to match elements (e.g., "h1", ".article-body", "#main-content")',
        },
        attribute: {
          type: 'string',
          description: 'Extract a specific attribute instead of text content (e.g., "href", "src")',
        },
        include_html: {
          type: 'boolean',
          description: 'Include raw HTML of matched elements (default: false, returns text only)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of elements to return (default: 20)',
        },
      },
      required: ['url', 'selector'],
    },
  },
  {
    name: 'send_image',
    description:
      'Send an image or screenshot file directly to the Telegram chat. Use this to share screenshots, generated images, or any image file with the user.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the image file to send (e.g., "/home/user/.kernelbot/screenshots/example.png")',
        },
        caption: {
          type: 'string',
          description: 'Optional caption to include with the image',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'interact_with_page',
    description:
      'Interact with a webpage by clicking elements, typing into inputs, scrolling, or executing JavaScript. Returns the page state after interaction.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to interact with',
        },
        actions: {
          type: 'array',
          description:
            'List of actions to perform in sequence. Each action is an object with a "type" field.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['click', 'type', 'scroll', 'wait', 'evaluate'],
                description: 'Action type',
              },
              selector: {
                type: 'string',
                description: 'CSS selector for the target element (for click and type actions)',
              },
              text: {
                type: 'string',
                description: 'Text to type (for type action)',
              },
              direction: {
                type: 'string',
                enum: ['down', 'up'],
                description: 'Scroll direction (for scroll action, default: down)',
              },
              pixels: {
                type: 'number',
                description: 'Number of pixels to scroll (default: 500)',
              },
              milliseconds: {
                type: 'number',
                description: 'Time to wait in ms (for wait action, default: 1000)',
              },
              script: {
                type: 'string',
                description: 'JavaScript to execute in the page context (for evaluate action). Must be a single expression or IIFE.',
              },
            },
            required: ['type'],
          },
        },
        extract_after: {
          type: 'boolean',
          description: 'Extract page content after performing actions (default: true)',
        },
      },
      required: ['url', 'actions'],
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleWebSearch(params) {
  if (!params.query || typeof params.query !== 'string') {
    return { error: 'query is required' };
  }

  const numResults = Math.min(params.num_results || 8, 20);

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;

    try {
      await navigateTo(page, searchUrl, 'domcontentloaded');
    } catch (err) {
      return { error: `Search failed: ${err.message}` };
    }

    const results = await page.evaluate((maxResults) => {
      const items = [];
      const resultElements = document.querySelectorAll('.result');
      for (let i = 0; i < Math.min(resultElements.length, maxResults); i++) {
        const el = resultElements[i];
        const titleEl = el.querySelector('.result__title a, .result__a');
        const snippetEl = el.querySelector('.result__snippet');
        const urlEl = el.querySelector('.result__url');

        if (titleEl) {
          items.push({
            title: titleEl.textContent.trim(),
            url: titleEl.href || '',
            snippet: snippetEl ? snippetEl.textContent.trim() : '',
            displayed_url: urlEl ? urlEl.textContent.trim() : '',
          });
        }
      }
      return items;
    }, numResults);

    if (results.length === 0) {
      return { success: true, query: params.query, results: [], message: 'No results found' };
    }

    return {
      success: true,
      query: params.query,
      result_count: results.length,
      results,
    };
  });
}

async function handleBrowse(params) {
  const validation = validateUrl(params.url);
  if (!validation.valid) return { error: validation.error };

  const url = validation.url;

  return withBrowser(async (browser) => {
    const page = await browser.newPage();

    try {
      await navigateTo(page, url);
    } catch (err) {
      if (err.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
        return { error: `Could not resolve hostname for: ${url}` };
      }
      if (err.message.includes('Timeout')) {
        return { error: `Page load timed out after ${NAVIGATION_TIMEOUT / 1000}s: ${url}` };
      }
      return { error: `Navigation failed: ${err.message}` };
    }

    // Wait for optional selector
    if (params.wait_for_selector) {
      try {
        await page.waitForSelector(params.wait_for_selector, { timeout: 10000 });
      } catch {
        // Continue even if selector not found
      }
    }

    const content = await page.evaluate((includeLinks) => {
      const title = document.title || '';
      const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
      const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || window.location.href;

      // Extract headings
      const headings = [];
      for (const tag of ['h1', 'h2', 'h3']) {
        document.querySelectorAll(tag).forEach((el) => {
          const text = el.textContent.trim();
          if (text) headings.push({ level: tag, text });
        });
      }

      // Extract main text content
      // Prefer common article/content containers
      const contentSelectors = [
        'article', 'main', '[role="main"]',
        '.content', '.article', '.post',
        '#content', '#main', '#article',
      ];

      let mainText = '';
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          mainText = el.innerText.trim();
          break;
        }
      }

      // Fall back to body text if no content container found
      if (!mainText) {
        // Remove script, style, nav, footer, header noise
        const clone = document.body.cloneNode(true);
        for (const el of clone.querySelectorAll('script, style, nav, footer, header, aside, [role="navigation"]')) {
          el.remove();
        }
        mainText = clone.innerText.trim();
      }

      // Extract links if requested
      let links = [];
      if (includeLinks) {
        document.querySelectorAll('a[href]').forEach((a) => {
          const text = a.textContent.trim();
          const href = a.href;
          if (text && href && !href.startsWith('javascript:')) {
            links.push({ text: text.slice(0, 100), href });
          }
        });
        links = links.slice(0, 50);
      }

      return { title, metaDesc, canonicalUrl, headings, mainText, links };
    }, true);

    return {
      success: true,
      url: page.url(),
      title: content.title,
      meta_description: content.metaDesc,
      canonical_url: content.canonicalUrl,
      headings: content.headings.slice(0, 30),
      content: truncate(content.mainText),
      links: content.links || [],
    };
  });
}

async function handleScreenshot(params, context) {
  const validation = validateUrl(params.url);
  if (!validation.valid) return { error: validation.error };

  const url = validation.url;
  await ensureScreenshotsDir();

  return withBrowser(async (browser) => {
    const page = await browser.newPage();

    try {
      await navigateTo(page, url);
    } catch (err) {
      if (err.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
        return { error: `Could not resolve hostname for: ${url}` };
      }
      if (err.message.includes('Timeout')) {
        return { error: `Page load timed out after ${NAVIGATION_TIMEOUT / 1000}s: ${url}` };
      }
      return { error: `Navigation failed: ${err.message}` };
    }

    const timestamp = Date.now();
    const safeName = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
    const filename = `${safeName}_${timestamp}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);

    const screenshotOptions = {
      path: filepath,
      type: 'png',
    };

    if (params.selector) {
      try {
        const element = await page.$(params.selector);
        if (!element) {
          return { error: `Element not found for selector: ${params.selector}` };
        }
        await element.screenshot(screenshotOptions);
      } catch (err) {
        return { error: `Failed to screenshot element: ${err.message}` };
      }
    } else {
      screenshotOptions.fullPage = params.full_page || false;
      await page.screenshot(screenshotOptions);
    }

    const title = await page.title();

    // Send the screenshot directly to Telegram chat
    if (context?.sendPhoto) {
      try {
        await context.sendPhoto(filepath, `📸 ${title || url}`);
      } catch {
        // Photo sending is best-effort; don't fail the tool
      }
    }

    return {
      success: true,
      url: page.url(),
      title,
      screenshot_path: filepath,
      filename,
      sent_to_chat: !!context?.sendPhoto,
    };
  });
}

async function handleExtract(params) {
  const validation = validateUrl(params.url);
  if (!validation.valid) return { error: validation.error };

  const url = validation.url;
  const limit = Math.min(params.limit || 20, 100);

  return withBrowser(async (browser) => {
    const page = await browser.newPage();

    try {
      await navigateTo(page, url);
    } catch (err) {
      if (err.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
        return { error: `Could not resolve hostname for: ${url}` };
      }
      if (err.message.includes('Timeout')) {
        return { error: `Page load timed out after ${NAVIGATION_TIMEOUT / 1000}s: ${url}` };
      }
      return { error: `Navigation failed: ${err.message}` };
    }

    const results = await page.evaluate(
      (selector, attribute, includeHtml, maxItems) => {
        const elements = document.querySelectorAll(selector);
        if (elements.length === 0) return { found: 0, items: [] };

        const items = [];
        for (let i = 0; i < Math.min(elements.length, maxItems); i++) {
          const el = elements[i];
          const item = {};

          if (attribute) {
            item.value = el.getAttribute(attribute) || null;
          } else {
            item.text = el.innerText?.trim() || el.textContent?.trim() || '';
          }

          if (includeHtml) {
            item.html = el.outerHTML;
          }

          item.tag = el.tagName.toLowerCase();
          items.push(item);
        }

        return { found: elements.length, items };
      },
      params.selector,
      params.attribute || null,
      params.include_html || false,
      limit
    );

    if (results.found === 0) {
      return {
        success: true,
        url: page.url(),
        selector: params.selector,
        found: 0,
        items: [],
        message: `No elements found matching selector: ${params.selector}`,
      };
    }

    // Truncate individual items to prevent massive responses
    for (const item of results.items) {
      if (item.text) item.text = truncate(item.text, 2000);
      if (item.html) item.html = truncate(item.html, 3000);
    }

    return {
      success: true,
      url: page.url(),
      selector: params.selector,
      found: results.found,
      returned: results.items.length,
      items: results.items,
    };
  });
}

async function handleInteract(params) {
  const validation = validateUrl(params.url);
  if (!validation.valid) return { error: validation.error };

  const url = validation.url;

  if (!params.actions || params.actions.length === 0) {
    return { error: 'At least one action is required' };
  }

  if (params.actions.length > 10) {
    return { error: 'Maximum 10 actions per request' };
  }

  // Block dangerous evaluate scripts
  for (const action of params.actions) {
    if (action.type === 'evaluate' && action.script) {
      const blocked = /fetch\s*\(|XMLHttpRequest|window\.location\s*=|document\.cookie|localStorage|sessionStorage/i;
      if (blocked.test(action.script)) {
        return { error: 'Script contains blocked patterns (network requests, cookie access, storage access, or redirects)' };
      }
    }
  }

  return withBrowser(async (browser) => {
    const page = await browser.newPage();

    try {
      await navigateTo(page, url);
    } catch (err) {
      if (err.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
        return { error: `Could not resolve hostname for: ${url}` };
      }
      if (err.message.includes('Timeout')) {
        return { error: `Page load timed out after ${NAVIGATION_TIMEOUT / 1000}s: ${url}` };
      }
      return { error: `Navigation failed: ${err.message}` };
    }

    const actionResults = [];

    for (const action of params.actions) {
      try {
        switch (action.type) {
          case 'click': {
            if (!action.selector) {
              actionResults.push({ action: 'click', error: 'selector is required' });
              break;
            }
            await page.waitForSelector(action.selector, { timeout: 5000 });
            await page.click(action.selector);
            // Brief wait for any navigation or rendering
            await new Promise((r) => setTimeout(r, 500));
            actionResults.push({ action: 'click', selector: action.selector, success: true });
            break;
          }

          case 'type': {
            if (!action.selector || !action.text) {
              actionResults.push({ action: 'type', error: 'selector and text are required' });
              break;
            }
            await page.waitForSelector(action.selector, { timeout: 5000 });
            await page.type(action.selector, action.text);
            actionResults.push({ action: 'type', selector: action.selector, success: true });
            break;
          }

          case 'scroll': {
            const direction = action.direction || 'down';
            const pixels = Math.min(action.pixels || 500, 5000);
            const scrollAmount = direction === 'up' ? -pixels : pixels;
            await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);
            actionResults.push({ action: 'scroll', direction, pixels, success: true });
            break;
          }

          case 'wait': {
            const ms = Math.min(action.milliseconds || 1000, 10000);
            await new Promise((r) => setTimeout(r, ms));
            actionResults.push({ action: 'wait', milliseconds: ms, success: true });
            break;
          }

          case 'evaluate': {
            if (!action.script) {
              actionResults.push({ action: 'evaluate', error: 'script is required' });
              break;
            }
            const result = await page.evaluate(action.script);
            actionResults.push({ action: 'evaluate', success: true, result: String(result).slice(0, 2000) });
            break;
          }

          default:
            actionResults.push({ action: action.type, error: `Unknown action type: ${action.type}` });
        }
      } catch (err) {
        actionResults.push({ action: action.type, error: err.message });
      }
    }

    const response = {
      success: true,
      url: page.url(),
      title: await page.title(),
      actions: actionResults,
    };

    // Extract content after interactions unless disabled
    if (params.extract_after !== false) {
      const text = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        for (const el of clone.querySelectorAll('script, style, nav, footer, header')) {
          el.remove();
        }
        return clone.innerText.trim();
      });
      response.content = truncate(text);
    }

    return response;
  });
}

async function handleSendImage(params, context) {
  if (!params.file_path) {
    return { error: 'file_path is required' };
  }

  // Verify the file exists
  try {
    await access(params.file_path);
  } catch {
    return { error: `File not found: ${params.file_path}` };
  }

  if (!context?.sendPhoto) {
    return { error: 'Image sending is not available in this context (no active Telegram chat)' };
  }

  try {
    await context.sendPhoto(params.file_path, params.caption || '');
    return { success: true, file_path: params.file_path, sent: true };
  } catch (err) {
    return { error: `Failed to send image: ${err.message}` };
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const handlers = {
  web_search: handleWebSearch,
  browse_website: handleBrowse,
  screenshot_website: handleScreenshot,
  extract_content: handleExtract,
  interact_with_page: handleInteract,
  send_image: handleSendImage,
};
