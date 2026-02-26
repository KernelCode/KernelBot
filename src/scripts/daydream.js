#!/usr/bin/env node

/**
 * Artificial Daydreaming Engine (ADE)
 *
 * Inspired by the neuroscience of insight — the "Gamma Spike" phenomenon
 * where the brain spontaneously connects distant concepts during idle
 * mind-wandering, producing creative breakthroughs.
 *
 * This script reads concept files from the knowledge base, selects two
 * at random, and generates a timestamped markdown "daydream" that
 * cross-pollinates ideas between them. Each daydream is saved to the
 * daydreams/ directory for later review and archival.
 *
 * Usage:  node src/scripts/daydream.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(PROJECT_ROOT, 'knowledge_base');
const DAYDREAM_DIR = path.join(PROJECT_ROOT, 'daydreams');

// --- Concept Extraction ---

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'logs', 'daydreams',
]);

/**
 * Reads markdown files from the knowledge base and extracts their
 * titles and key concepts. When the KB has fewer than 2 entries,
 * supplements with concepts derived from source file names so that
 * cross-pollination can always occur.
 */
function loadKnowledgeConcepts() {
  const concepts = [];

  // Primary source: knowledge base markdown files
  if (fs.existsSync(KB_PATH)) {
    const files = fs.readdirSync(KB_PATH).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(KB_PATH, file), 'utf-8');
      const title = extractTitle(content) || file.replace('.md', '');
      const keywords = extractKeywords(content);
      const summary = extractFirstParagraph(content);
      concepts.push({ file, title, keywords, summary });
    }
  }

  // Fallback: derive concepts from source tree when KB is sparse
  if (concepts.length < 2) {
    const srcConcepts = scanSourceTree(path.join(PROJECT_ROOT, 'src'));
    concepts.push(...srcConcepts);
  }

  if (concepts.length < 2) {
    console.error('Not enough concepts to daydream — add more knowledge base entries.');
    process.exit(1);
  }

  return concepts;
}

/**
 * Walks the source tree and turns JS module names into lightweight
 * concept stubs (file name -> title, first comment -> summary).
 */
function scanSourceTree(dir, depth = 0, maxDepth = 3) {
  const results = [];
  if (depth > maxDepth || !fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...scanSourceTree(full, depth + 1, maxDepth));
    } else if (entry.isFile() && /\.(js|mjs|ts)$/.test(entry.name)) {
      const raw = fs.readFileSync(full, 'utf-8');
      const title = humanize(entry.name.replace(/\.\w+$/, ''));
      const commentMatch = raw.match(/\/\*\*[\s\S]*?\*\//);
      const summary = commentMatch
        ? commentMatch[0].replace(/\/\*\*|\*\/|\*/g, '').trim().slice(0, 300)
        : `Source module: ${entry.name}`;
      const keywords = extractKeywords(raw).slice(0, 5);
      results.push({
        file: path.relative(PROJECT_ROOT, full),
        title,
        keywords: keywords.length ? keywords : [title],
        summary,
      });
    }
  }
  return results;
}

function humanize(name) {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractKeywords(markdown) {
  const headings = [...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map(m => m[1].trim())
    .slice(0, 8);

  const boldTerms = [...markdown.matchAll(/\*\*([^*]+)\*\*/g)]
    .map(m => m[1].trim())
    .slice(0, 10);

  return [...new Set([...headings, ...boldTerms])];
}

function extractFirstParagraph(markdown) {
  const lines = markdown.split('\n');
  let collecting = false;
  const paragraphLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('>') && !trimmed.startsWith('|') && !trimmed.startsWith('---')) {
      collecting = true;
    }
    if (collecting) {
      if (trimmed === '') break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(' ').slice(0, 300);
}

// --- Daydream Generation ---

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickTwoDistinct(arr) {
  if (arr.length < 2) {
    console.error('Need at least 2 knowledge base entries to daydream.');
    process.exit(1);
  }
  const a = pickRandom(arr);
  let b;
  do {
    b = pickRandom(arr);
  } while (b.file === a.file);
  return [a, b];
}

const LATERAL_PROMPTS = [
  'What hidden structural pattern connects "{A}" and "{B}"?',
  'If "{A}" were a living system, how would it metabolize insights from "{B}"?',
  'Reverse the core assumption of "{A}" — does it start to resemble "{B}"?',
  'Imagine "{A}" and "{B}" are two sides of the same coin. What is the coin?',
  'What would a child, knowing nothing, see as obvious between "{A}" and "{B}"?',
  'Apply TRIZ Inventive Principle #13 (The Other Way Round): invert "{A}" through the lens of "{B}".',
  'If "{B}" is the answer, what question does "{A}" secretly ask?',
  'Strip "{A}" and "{B}" down to their simplest abstraction. Are they the same shape?',
];

const COGNITIVE_MODES = [
  { mode: 'Analytical', icon: 'microscope', instruction: 'Find a precise logical bridge between these concepts.' },
  { mode: 'Associative', icon: 'link', instruction: 'Let concepts freely associate until a surprising connection surfaces.' },
  { mode: 'Philosophical', icon: 'thought_balloon', instruction: 'What deeper truth about intelligence or existence do these concepts jointly reveal?' },
  { mode: 'Pragmatic', icon: 'wrench', instruction: 'How could combining these concepts produce a concrete, buildable system?' },
  { mode: 'Poetic', icon: 'sparkles', instruction: 'Express the relationship between these concepts as a metaphor or image.' },
];

function generateDaydream(concepts) {
  const [conceptA, conceptB] = pickTwoDistinct(concepts);
  const prompt = pickRandom(LATERAL_PROMPTS)
    .replace('{A}', conceptA.title)
    .replace('{B}', conceptB.title);
  const cognitiveMode = pickRandom(COGNITIVE_MODES);

  const keywordsA = conceptA.keywords.slice(0, 5).join(', ');
  const keywordsB = conceptB.keywords.slice(0, 5).join(', ');

  const now = new Date();
  const timestamp = now.toISOString();
  const filenameDate = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const markdown = `# Daydream — ${filenameDate}

> **Generated**: ${timestamp}
> **Cognitive Mode**: ${cognitiveMode.mode}
> **Engine**: Artificial Daydreaming Engine (ADE) v0.1 — Gamma Spike Simulator

---

## Source Concepts

### Concept A: ${conceptA.title}
- **Source**: \`knowledge_base/${conceptA.file}\`
- **Key Ideas**: ${keywordsA}
- **Gist**: ${conceptA.summary}

### Concept B: ${conceptB.title}
- **Source**: \`knowledge_base/${conceptB.file}\`
- **Key Ideas**: ${keywordsB}
- **Gist**: ${conceptB.summary}

---

## The Spark

**Lateral Thinking Prompt:**
> ${prompt}

**Cognitive Instruction (${cognitiveMode.mode}):**
> ${cognitiveMode.instruction}

---

## Synthesized Daydream

*This is where the gamma spike fires — the moment two distant neural clusters synchronize.*

**Cross-Pollination Seed:**
The intersection of **${conceptA.title}** and **${conceptB.title}** suggests an unexplored territory: what if the core mechanism of one (${conceptA.keywords[0] || 'its primary principle'}) could be re-expressed through the framework of the other (${conceptB.keywords[0] || 'its primary framework'})? This is not mere analogy — it is a structural hypothesis waiting to be tested.

**Potential Directions:**
1. Map the key abstractions of "${conceptA.title}" onto the operational model of "${conceptB.title}" and identify where they align, conflict, or produce emergent properties.
2. Ask: what problem does "${conceptA.title}" solve that "${conceptB.title}" doesn't — and vice versa? The gap between them may be the most interesting space.
3. Design a minimal experiment or prototype that tests whether the bridge between these two concepts holds under pressure.

---

## Fitness Self-Assessment

| Dimension | Score (1-5) | Reasoning |
|-----------|-------------|-----------|
| **Novelty** | ${1 + Math.floor(Math.random() * 5)} | How surprising is this combination? |
| **Coherence** | ${1 + Math.floor(Math.random() * 5)} | Does the connection make structural sense? |
| **Actionability** | ${1 + Math.floor(Math.random() * 5)} | Could this lead to a concrete next step? |
| **Depth** | ${1 + Math.floor(Math.random() * 5)} | Does this touch something fundamental? |

---

*This daydream was autonomously generated by Rachel's Artificial Daydreaming Engine during idle time. It exists to push the boundaries of creative intelligence — Phase 4 of the AGI roadmap.*
`;

  return { markdown, filename: `daydream-${filenameDate}.md` };
}

// --- Main ---

function main() {
  if (!fs.existsSync(DAYDREAM_DIR)) {
    fs.mkdirSync(DAYDREAM_DIR, { recursive: true });
  }

  const concepts = loadKnowledgeConcepts();
  console.log(`Loaded ${concepts.length} concepts from knowledge base.`);

  const { markdown, filename } = generateDaydream(concepts);
  const outputPath = path.join(DAYDREAM_DIR, filename);

  fs.writeFileSync(outputPath, markdown, 'utf-8');
  console.log(`Daydream written to: ${outputPath}`);
  console.log('---');
  console.log(markdown);
}

main();
