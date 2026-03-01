import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/ids.js';
import { todayDateStr } from '../utils/date.js';

/**
 * DaydreamEngine — Artificial Daydreaming via MAP-Elites
 *
 * Implements a quality-diversity search over the space of creative thoughts.
 * Instead of optimising for a single "best" idea, MAP-Elites maintains an
 * archive of the best idea *per niche*, producing a diverse repertoire of
 * high-quality insights that Rachel can draw on.
 *
 * ─── How It Works ────────────────────────────────────────────────────
 *
 *  1. **generateThought()**  — Produce a candidate thought by cross-
 *     pollinating concepts from the knowledge base (via LLM).
 *
 *  2. **evaluateFitness()**  — Score the thought on novelty, depth,
 *     and actionability (via LLM or heuristic).
 *
 *  3. **classifyNiche()**    — Map the thought to a cell in the
 *     behaviour-descriptor grid (domain × cognitiveStrategy).
 *
 *  4. **storeInArchive()**   — If the cell is empty or the new thought
 *     beats the incumbent, replace it.
 *
 *  5. **runCycle()**         — Orchestrate one full MAP-Elites iteration
 *     (steps 1–4), called periodically by the LifeEngine.
 *
 * ─── Behaviour Descriptors ──────────────────────────────────────────
 *
 *  Axis 1 — Domain:
 *    technical | creative | philosophical | interpersonal | strategic | self_improvement
 *
 *  Axis 2 — Cognitive Strategy (from MetacognitionMonitor):
 *    analytical_decomposition | analogical_reasoning | first_principles |
 *    lateral_thinking | divergent_exploration | dialectical_reasoning |
 *    counterfactual_thinking | abductive_inference
 *
 *  Archive size = 6 domains × 8 strategies = 48 cells.
 *
 * ─── Persistence ────────────────────────────────────────────────────
 *
 *  Archive and run history are stored as JSON in ~/.kernelbot/life/daydream/.
 *
 * @see MetacognitionMonitor — provides cognitive-strategy vocabulary and self-awareness context
 * @see LifeEngine — triggers daydream cycles during idle "think" activities
 */

const LIFE_DIR = join(homedir(), '.kernelbot', 'life');

/** The domain axis of the MAP-Elites grid. */
const DOMAINS = [
  'technical',
  'creative',
  'philosophical',
  'interpersonal',
  'strategic',
  'self_improvement',
];

/** The cognitive-strategy axis of the MAP-Elites grid. */
const STRATEGIES = [
  'analytical_decomposition',
  'analogical_reasoning',
  'first_principles',
  'lateral_thinking',
  'divergent_exploration',
  'dialectical_reasoning',
  'counterfactual_thinking',
  'abductive_inference',
];

/**
 * A single thought stored in the archive.
 * @typedef {object} DaydreamThought
 * @property {string}  id          — Unique ID (prefix 'dd')
 * @property {string}  date        — ISO date string (YYYY-MM-DD)
 * @property {number}  timestamp   — Epoch ms
 * @property {string}  content     — The synthesised thought / insight
 * @property {string}  domain      — Which domain axis cell
 * @property {string}  strategy    — Which strategy axis cell
 * @property {number}  fitness     — Composite fitness score (0–1)
 * @property {object}  fitnessBreakdown — { novelty, depth, actionability } each 0–1
 * @property {string[]} seedConcepts — Knowledge-base concepts that seeded this thought
 * @property {number}  generation  — Which MAP-Elites cycle produced this
 */

/**
 * Run-level stats for a single MAP-Elites cycle.
 * @typedef {object} CycleResult
 * @property {number}  generation      — Cycle number
 * @property {string}  date            — ISO date string
 * @property {boolean} stored          — Whether the thought entered the archive
 * @property {string|null} replacedId  — ID of the thought it displaced (if any)
 * @property {DaydreamThought} thought — The candidate thought
 */

export class DaydreamEngine {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.basePath]           — Override base directory (for testing)
   * @param {object}  [opts.metacognition]      — MetacognitionMonitor instance (for context)
   * @param {object}  [opts.knowledgeBasePath]  — Path to the knowledge-base directory
   */
  constructor(opts = {}) {
    const lifeDir = opts.basePath || LIFE_DIR;
    this._dir = join(lifeDir, 'daydream');
    this._archiveFile = join(this._dir, 'archive.json');
    this._historyFile = join(this._dir, 'history.json');
    this._metacognition = opts.metacognition || null;
    this._knowledgeBasePath = opts.knowledgeBasePath || '/root/kernelbot/knowledge_base';

    mkdirSync(this._dir, { recursive: true });

    this._archive = this._loadFile(this._archiveFile, {});
    this._history = this._loadFile(this._historyFile, []);
    this._generation = this._history.length;
  }

  // ── MAP-Elites Core Loop ─────────────────────────────────────────

  /**
   * Run one full MAP-Elites cycle: generate → evaluate → classify → store.
   *
   * This is the top-level method that the LifeEngine should call during
   * idle "think" activities. Each call produces one candidate thought and
   * attempts to place it in the archive.
   *
   * @returns {Promise<CycleResult>} Result of this cycle
   */
  async runCycle() {
    const logger = getLogger();
    this._generation++;
    logger.info(`[Daydream] Starting MAP-Elites cycle #${this._generation}`);

    // Step 1 — Generate a candidate thought
    const thought = await this.generateThought();

    // Step 2 — Evaluate its fitness
    const fitness = await this.evaluateFitness(thought);
    thought.fitness = fitness.composite;
    thought.fitnessBreakdown = fitness;

    // Step 3 — Classify into a niche
    const niche = this.classifyNiche(thought);
    thought.domain = niche.domain;
    thought.strategy = niche.strategy;

    // Step 4 — Attempt to store in the archive
    const storeResult = this.storeInArchive(thought);

    // Record history
    const result = {
      generation: this._generation,
      date: todayDateStr(),
      stored: storeResult.stored,
      replacedId: storeResult.replacedId,
      thought,
    };
    this._history.push(result);

    // Cap history at 200 entries
    if (this._history.length > 200) {
      this._history = this._history.slice(-200);
    }
    this._saveFile(this._historyFile, this._history);

    logger.info(
      `[Daydream] Cycle #${this._generation} complete: ` +
      `domain=${thought.domain}, strategy=${thought.strategy}, ` +
      `fitness=${thought.fitness.toFixed(2)}, stored=${storeResult.stored}`
    );

    return result;
  }

  // ── Step 1: Thought Generation ───────────────────────────────────

  /**
   * Generate a candidate thought by cross-pollinating concepts from the
   * knowledge base.
   *
   * Phase 1 (skeleton): Returns a placeholder thought structure.
   * Phase 2 (future):   Will sample random knowledge-base entries, build a
   *                      creative prompt, and call the LLM to synthesise a
   *                      novel insight that bridges the sampled concepts.
   *
   * @returns {Promise<DaydreamThought>}
   */
  async generateThought() {
    // TODO Phase 2: Sample 2–3 random entries from the knowledge base
    // TODO Phase 2: Build a creative cross-pollination prompt
    // TODO Phase 2: Call LLM to generate a synthesised insight
    // TODO Phase 2: Parse the LLM response into a DaydreamThought

    return {
      id: genId('dd'),
      date: todayDateStr(),
      timestamp: Date.now(),
      content: '',       // Will be filled by LLM in Phase 2
      domain: '',        // Will be classified in classifyNiche()
      strategy: '',      // Will be classified in classifyNiche()
      fitness: 0,
      fitnessBreakdown: { novelty: 0, depth: 0, actionability: 0 },
      seedConcepts: [],  // Will hold sampled KB entry titles
      generation: this._generation,
    };
  }

  // ── Step 2: Fitness Evaluation ───────────────────────────────────

  /**
   * Evaluate a thought's fitness across three dimensions:
   *   - **Novelty**:       How different is this from existing archive entries?
   *   - **Depth**:         How substantive and well-reasoned is the insight?
   *   - **Actionability**: Could this lead to a concrete goal, project, or behaviour change?
   *
   * Phase 1 (skeleton): Returns zeroed scores.
   * Phase 2 (future):   Will use LLM-as-judge and/or heuristic comparison
   *                      against existing archive entries to score each axis.
   *
   * @param {DaydreamThought} thought — The candidate thought to evaluate
   * @returns {Promise<{ novelty: number, depth: number, actionability: number, composite: number }>}
   */
  async evaluateFitness(thought) {
    // TODO Phase 2: Compare thought.content against existing archive for novelty
    // TODO Phase 2: LLM-as-judge scoring for depth and actionability
    // TODO Phase 2: Compute weighted composite score

    return {
      novelty: 0,
      depth: 0,
      actionability: 0,
      composite: 0,
    };
  }

  // ── Step 3: Niche Classification ─────────────────────────────────

  /**
   * Map a thought to a cell in the MAP-Elites behaviour-descriptor grid.
   *
   * The grid has two axes:
   *   - Domain (6 values):   technical, creative, philosophical, interpersonal, strategic, self_improvement
   *   - Strategy (8 values): analytical_decomposition, analogical_reasoning, etc.
   *
   * Phase 1 (skeleton): Uses the thought's pre-set domain/strategy or defaults.
   * Phase 2 (future):   Will use LLM classification or keyword heuristics to
   *                      determine the most fitting niche.
   *
   * @param {DaydreamThought} thought — The thought to classify
   * @returns {{ domain: string, strategy: string }}
   */
  classifyNiche(thought) {
    // TODO Phase 2: LLM or heuristic classification of domain + strategy

    const domain = DOMAINS.includes(thought.domain) ? thought.domain : DOMAINS[0];
    const strategy = STRATEGIES.includes(thought.strategy) ? thought.strategy : STRATEGIES[0];

    return { domain, strategy };
  }

  // ── Step 4: Archive Storage ──────────────────────────────────────

  /**
   * Attempt to store a thought in the MAP-Elites archive.
   *
   * Archive is keyed by "domain::strategy". If the cell is empty, the thought
   * is inserted. If occupied, the thought replaces the incumbent only if its
   * fitness is strictly higher.
   *
   * @param {DaydreamThought} thought — The thought to store
   * @returns {{ stored: boolean, replacedId: string|null }}
   */
  storeInArchive(thought) {
    const key = `${thought.domain}::${thought.strategy}`;
    const existing = this._archive[key];

    if (!existing || thought.fitness > existing.fitness) {
      const replacedId = existing?.id || null;
      this._archive[key] = thought;
      this._saveFile(this._archiveFile, this._archive);
      return { stored: true, replacedId };
    }

    return { stored: false, replacedId: null };
  }

  // ── Queries ──────────────────────────────────────────────────────

  /**
   * Get the full archive as an object keyed by "domain::strategy".
   * @returns {Record<string, DaydreamThought>}
   */
  getArchive() {
    return { ...this._archive };
  }

  /**
   * Get the number of filled cells out of the total grid size.
   * @returns {{ filled: number, total: number, coverage: number }}
   */
  getCoverage() {
    const total = DOMAINS.length * STRATEGIES.length;
    const filled = Object.keys(this._archive).length;
    return { filled, total, coverage: total > 0 ? Math.round((filled / total) * 100) : 0 };
  }

  /**
   * Get the top N thoughts across the archive, ranked by fitness.
   * @param {number} n
   * @returns {DaydreamThought[]}
   */
  getTopThoughts(n = 5) {
    return Object.values(this._archive)
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, n);
  }

  /**
   * Get recent cycle history.
   * @param {number} limit
   * @returns {CycleResult[]}
   */
  getHistory(limit = 10) {
    return this._history.slice(-limit);
  }

  /**
   * Build a context block summarising the daydream archive for use in LLM prompts.
   * Gives the thinking self a window into its creative repertoire.
   *
   * @returns {string|null}
   */
  buildContextBlock() {
    const coverage = this.getCoverage();
    if (coverage.filled === 0) return null;

    const top = this.getTopThoughts(3);
    const sections = ['## Creative Repertoire (Daydream Archive)'];
    sections.push(`Coverage: ${coverage.filled}/${coverage.total} niches (${coverage.coverage}%)`);
    sections.push(`Total cycles: ${this._generation}`);

    if (top.length > 0) {
      sections.push('Top insights:');
      for (const t of top) {
        const label = `${t.domain} × ${t.strategy.replace(/_/g, ' ')}`;
        const snippet = t.content ? t.content.slice(0, 120) : '(pending)';
        sections.push(`- [${label}] (fitness ${t.fitness.toFixed(2)}): ${snippet}`);
      }
    }

    let block = sections.join('\n');
    if (block.length > 600) block = block.slice(0, 600) + '\n...';
    return block;
  }

  /**
   * Get the grid dimensions — useful for external visualisation or testing.
   * @returns {{ domains: string[], strategies: string[] }}
   */
  static getGridDimensions() {
    return { domains: [...DOMAINS], strategies: [...STRATEGIES] };
  }

  // ── File Helpers ─────────────────────────────────────────────────

  _loadFile(filePath, defaultValue) {
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        return structuredClone(defaultValue);
      }
    }
    return structuredClone(defaultValue);
  }

  _saveFile(filePath, data) {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
