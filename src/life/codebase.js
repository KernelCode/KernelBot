import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger.js';

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');
const CODEBASE_DIR = join(LIFE_DIR, 'codebase');
const SUMMARIES_FILE = join(CODEBASE_DIR, 'file-summaries.json');
const ARCHITECTURE_FILE = join(CODEBASE_DIR, 'architecture.md');

// Files to always skip during scanning
const SKIP_PATTERNS = [
  'node_modules', '.git', 'package-lock.json', 'yarn.lock',
  '.env', '.DS_Store', 'dist/', 'build/', 'coverage/',
];

export class CodebaseKnowledge {
  constructor({ config } = {}) {
    this.config = config || {};
    this._projectRoot = null;
    this._summaries = {};
    this._agent = null;

    mkdirSync(CODEBASE_DIR, { recursive: true });
    this._summaries = this._loadSummaries();
  }

  /** Set the agent reference (called after agent is created). */
  setAgent(agent) {
    this._agent = agent;
  }

  /** Set/detect project root. */
  setProjectRoot(root) {
    this._projectRoot = root;
  }

  getProjectRoot() {
    if (this._projectRoot) return this._projectRoot;
    // Try to detect from git
    try {
      this._projectRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    } catch {
      this._projectRoot = process.cwd();
    }
    return this._projectRoot;
  }

  // ── Persistence ───────────────────────────────────────────────

  _loadSummaries() {
    if (existsSync(SUMMARIES_FILE)) {
      try {
        return JSON.parse(readFileSync(SUMMARIES_FILE, 'utf-8'));
      } catch {
        return {};
      }
    }
    return {};
  }

  _saveSummaries() {
    writeFileSync(SUMMARIES_FILE, JSON.stringify(this._summaries, null, 2), 'utf-8');
  }

  _saveArchitecture(content) {
    writeFileSync(ARCHITECTURE_FILE, content, 'utf-8');
  }

  // ── File Hashing ──────────────────────────────────────────────

  _hashFile(filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return createHash('md5').update(content).digest('hex').slice(0, 12);
    } catch {
      return null;
    }
  }

  _lineCount(filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  // ── Scanning ──────────────────────────────────────────────────

  /**
   * Scan a single file using the LLM to generate a summary.
   * Requires this._agent to be set.
   */
  async scanFile(filePath) {
    const logger = getLogger();
    const root = this.getProjectRoot();
    const fullPath = filePath.startsWith('/') ? filePath : join(root, filePath);
    const relativePath = filePath.startsWith('/') ? filePath.replace(root + '/', '') : filePath;

    // Check if file should be skipped
    if (SKIP_PATTERNS.some(p => relativePath.includes(p))) return null;

    const hash = this._hashFile(fullPath);
    if (!hash) return null;

    // Skip if already scanned and unchanged
    const existing = this._summaries[relativePath];
    if (existing && existing.lastHash === hash) return existing;

    // Read file content
    let content;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }

    // Truncate very large files
    const maxChars = 8000;
    const truncated = content.length > maxChars
      ? content.slice(0, maxChars) + '\n... (truncated)'
      : content;

    // Use LLM to summarize if agent is available
    let summary;
    if (this._agent) {
      try {
        const prompt = `Analyze this source file and respond with ONLY a JSON object (no markdown, no code blocks):
{
  "summary": "one-paragraph description of what this file does",
  "exports": ["list", "of", "exported", "names"],
  "dependencies": ["list", "of", "local", "imports"]
}

File: ${relativePath}
\`\`\`
${truncated}
\`\`\``;

        const response = await this._agent.orchestratorProvider.chat({
          system: 'You are a code analysis assistant. Respond with only valid JSON, no markdown formatting.',
          messages: [{ role: 'user', content: prompt }],
        });

        const text = (response.text || '').trim();
        // Try to parse JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          summary = {
            summary: parsed.summary || 'No summary generated',
            exports: parsed.exports || [],
            dependencies: parsed.dependencies || [],
          };
        }
      } catch (err) {
        logger.debug(`[Codebase] LLM scan failed for ${relativePath}: ${err.message}`);
      }
    }

    // Fallback: basic static analysis
    if (!summary) {
      summary = this._staticAnalysis(content, relativePath);
    }

    const entry = {
      ...summary,
      lineCount: this._lineCount(fullPath),
      lastHash: hash,
      lastScanned: Date.now(),
    };

    this._summaries[relativePath] = entry;
    this._saveSummaries();
    logger.debug(`[Codebase] Scanned: ${relativePath}`);
    return entry;
  }

  /**
   * Scan only files that have changed since last scan (git-based).
   */
  async scanChanged() {
    const logger = getLogger();
    const root = this.getProjectRoot();

    let changedFiles = [];
    try {
      // Get all tracked files that differ from what we've scanned
      const allFiles = execSync('git ls-files --full-name', {
        cwd: root,
        encoding: 'utf-8',
      }).trim().split('\n').filter(Boolean);

      // Filter to source files
      changedFiles = allFiles.filter(f =>
        (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.md')) &&
        !SKIP_PATTERNS.some(p => f.includes(p))
      );

      // Only scan files whose hash has changed
      changedFiles = changedFiles.filter(f => {
        const fullPath = join(root, f);
        const hash = this._hashFile(fullPath);
        const existing = this._summaries[f];
        return !existing || existing.lastHash !== hash;
      });
    } catch (err) {
      logger.warn(`[Codebase] Git scan failed: ${err.message}`);
      return 0;
    }

    logger.info(`[Codebase] Scanning ${changedFiles.length} changed files...`);
    let scanned = 0;

    for (const file of changedFiles) {
      try {
        await this.scanFile(file);
        scanned++;
      } catch (err) {
        logger.debug(`[Codebase] Failed to scan ${file}: ${err.message}`);
      }
    }

    logger.info(`[Codebase] Scan complete: ${scanned} files updated`);
    return scanned;
  }

  /**
   * Full scan of all source files. Heavy operation — use sparingly.
   */
  async scanAll() {
    const logger = getLogger();
    const root = this.getProjectRoot();

    let allFiles = [];
    try {
      allFiles = execSync('git ls-files --full-name', {
        cwd: root,
        encoding: 'utf-8',
      }).trim().split('\n').filter(Boolean);

      allFiles = allFiles.filter(f =>
        (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.md')) &&
        !SKIP_PATTERNS.some(p => f.includes(p))
      );
    } catch (err) {
      logger.warn(`[Codebase] Git ls-files failed: ${err.message}`);
      return 0;
    }

    logger.info(`[Codebase] Full scan: ${allFiles.length} files...`);
    let scanned = 0;

    for (const file of allFiles) {
      try {
        await this.scanFile(file);
        scanned++;
      } catch (err) {
        logger.debug(`[Codebase] Failed to scan ${file}: ${err.message}`);
      }
    }

    logger.info(`[Codebase] Full scan complete: ${scanned} files`);
    return scanned;
  }

  // ── Queries ───────────────────────────────────────────────────

  getFileSummary(path) {
    return this._summaries[path] || null;
  }

  getAllSummaries() {
    return { ...this._summaries };
  }

  getArchitecture() {
    if (existsSync(ARCHITECTURE_FILE)) {
      try {
        return readFileSync(ARCHITECTURE_FILE, 'utf-8');
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Find files relevant to a proposed change description.
   * Returns file paths sorted by relevance.
   */
  getRelevantFiles(description) {
    const descLower = description.toLowerCase();
    const keywords = descLower.split(/\W+/).filter(w => w.length > 2);

    const scored = Object.entries(this._summaries).map(([path, info]) => {
      let score = 0;
      const text = `${path} ${info.summary || ''}`.toLowerCase();

      for (const keyword of keywords) {
        if (text.includes(keyword)) score++;
      }

      return { path, score, summary: info.summary };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
  }

  /**
   * Regenerate the architecture overview from all summaries.
   */
  async updateArchitecture() {
    const logger = getLogger();
    const entries = Object.entries(this._summaries);
    if (entries.length === 0) return;

    // Group by directory
    const byDir = {};
    for (const [path, info] of entries) {
      const dir = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '.';
      if (!byDir[dir]) byDir[dir] = [];
      byDir[dir].push({ path, ...info });
    }

    // Build a compact summary for LLM
    const summaryText = Object.entries(byDir)
      .map(([dir, files]) => {
        const fileLines = files
          .map(f => `  - ${f.path}: ${(f.summary || 'no summary').slice(0, 120)}`)
          .join('\n');
        return `### ${dir}/\n${fileLines}`;
      })
      .join('\n\n');

    if (this._agent) {
      try {
        const prompt = `Based on these file summaries, write a concise architecture overview document in Markdown. Include: project structure, key components, data flow, and patterns used.

${summaryText}`;

        const response = await this._agent.orchestratorProvider.chat({
          system: 'You are a software architect. Write clear, concise architecture documentation.',
          messages: [{ role: 'user', content: prompt }],
        });

        if (response.text) {
          this._saveArchitecture(response.text);
          logger.info(`[Codebase] Architecture doc updated (${response.text.length} chars)`);
        }
      } catch (err) {
        logger.warn(`[Codebase] Architecture update failed: ${err.message}`);
      }
    } else {
      // Fallback: just dump the summaries
      const doc = `# KERNEL Architecture\n\n_Auto-generated on ${new Date().toISOString()}_\n\n${summaryText}`;
      this._saveArchitecture(doc);
    }
  }

  // ── Static Analysis Fallback ──────────────────────────────────

  _staticAnalysis(content, filePath) {
    const exports = [];
    const dependencies = [];

    // Extract exports
    const exportMatches = content.matchAll(/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g);
    for (const m of exportMatches) exports.push(m[1]);

    // Extract local imports
    const importMatches = content.matchAll(/from\s+['"](\.[^'"]+)['"]/g);
    for (const m of importMatches) dependencies.push(m[1]);

    // Simple summary based on file path
    let summary = `Source file at ${filePath}`;
    if (exports.length > 0) summary += ` — exports: ${exports.join(', ')}`;

    return { summary, exports, dependencies };
  }
}
