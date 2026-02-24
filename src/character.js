import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getLogger } from './utils/logger.js';
import { BUILTIN_CHARACTERS } from './characters/builtins.js';
import { SelfManager } from './self.js';
import { MemoryManager } from './life/memory.js';
import { JournalManager } from './life/journal.js';
import { ShareQueue } from './life/share-queue.js';
import { EvolutionTracker } from './life/evolution.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNELBOT_DIR = join(homedir(), '.kernelbot');
const CHARACTERS_DIR = join(KERNELBOT_DIR, 'characters');
const REGISTRY_FILE = join(CHARACTERS_DIR, 'registry.json');

const DEFAULT_REGISTRY = {
  activeCharacterId: 'kernel',
  characters: {},
};

export class CharacterManager {
  constructor() {
    this._registry = null;
    this.needsOnboarding = false;
    mkdirSync(CHARACTERS_DIR, { recursive: true });
    this._load();
  }

  // ── Registry Persistence ─────────────────────────────────────

  _load() {
    const logger = getLogger();

    if (existsSync(REGISTRY_FILE)) {
      try {
        this._registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
        logger.debug(`[CharacterManager] Loaded registry: ${Object.keys(this._registry.characters).length} characters`);
      } catch {
        this._registry = { ...DEFAULT_REGISTRY, characters: {} };
      }
      return;
    }

    // No registry exists — check if we need migration or fresh onboarding
    const legacySelfDir = join(KERNELBOT_DIR, 'self');
    if (existsSync(legacySelfDir)) {
      // Existing installation — migrate to kernel character
      logger.info('[CharacterManager] Legacy data detected — migrating to kernel character');
      this._migrateToKernel();
    } else {
      // Fresh install — needs onboarding
      logger.info('[CharacterManager] Fresh install — onboarding needed');
      this._registry = { ...DEFAULT_REGISTRY, characters: {} };
      this.needsOnboarding = true;
    }
  }

  _save() {
    writeFileSync(REGISTRY_FILE, JSON.stringify(this._registry, null, 2), 'utf-8');
  }

  // ── Migration ────────────────────────────────────────────────

  _migrateToKernel() {
    const logger = getLogger();
    const kernelDir = join(CHARACTERS_DIR, 'kernel');
    mkdirSync(kernelDir, { recursive: true });

    // Copy self/ → characters/kernel/self/
    const legacySelfDir = join(KERNELBOT_DIR, 'self');
    const targetSelfDir = join(kernelDir, 'self');
    if (existsSync(legacySelfDir) && !existsSync(targetSelfDir)) {
      cpSync(legacySelfDir, targetSelfDir, { recursive: true });
      logger.info('[CharacterManager] Migrated self/ → characters/kernel/self/');
    }

    // Copy life/ → characters/kernel/life/
    const legacyLifeDir = join(KERNELBOT_DIR, 'life');
    const targetLifeDir = join(kernelDir, 'life');
    if (existsSync(legacyLifeDir) && !existsSync(targetLifeDir)) {
      cpSync(legacyLifeDir, targetLifeDir, { recursive: true });
      logger.info('[CharacterManager] Migrated life/ → characters/kernel/life/');
    }

    // Copy conversations.json → characters/kernel/conversations.json
    // Re-key all conversation and skill entries with "kernel:" prefix
    // so they match the new _chatKey() scoping in agent.js
    const legacyConvFile = join(KERNELBOT_DIR, 'conversations.json');
    const targetConvFile = join(kernelDir, 'conversations.json');
    if (existsSync(legacyConvFile) && !existsSync(targetConvFile)) {
      try {
        const raw = JSON.parse(readFileSync(legacyConvFile, 'utf-8'));
        const migrated = {};

        for (const [key, value] of Object.entries(raw)) {
          if (key === '_skills') {
            // Re-key skills: "12345" → "kernel:12345"
            const migratedSkills = {};
            for (const [skillKey, skillId] of Object.entries(value)) {
              const newKey = skillKey.startsWith('kernel:') || skillKey.startsWith('__life__') ? skillKey : `kernel:${skillKey}`;
              migratedSkills[newKey] = skillId;
            }
            migrated._skills = migratedSkills;
          } else if (key.startsWith('__life__')) {
            // Re-key life engine chat: "__life__" → "__life__:kernel"
            migrated[key === '__life__' ? '__life__:kernel' : key] = value;
          } else {
            // Re-key user chats: "12345" → "kernel:12345"
            const newKey = key.startsWith('kernel:') ? key : `kernel:${key}`;
            migrated[newKey] = value;
          }
        }

        writeFileSync(targetConvFile, JSON.stringify(migrated, null, 2), 'utf-8');
        logger.info('[CharacterManager] Migrated conversations.json (re-keyed with kernel: prefix)');
      } catch (err) {
        // Fallback: just copy as-is if parsing fails
        cpSync(legacyConvFile, targetConvFile);
        logger.warn(`[CharacterManager] Migrated conversations.json (raw copy, re-key failed: ${err.message})`);
      }
    }

    // Copy persona.md from source
    const defaultPersonaMd = join(__dirname, 'prompts', 'persona.md');
    const targetPersonaMd = join(kernelDir, 'persona.md');
    if (existsSync(defaultPersonaMd) && !existsSync(targetPersonaMd)) {
      cpSync(defaultPersonaMd, targetPersonaMd);
      logger.info('[CharacterManager] Copied persona.md to kernel character');
    }

    // Create profile.json
    const profileFile = join(kernelDir, 'profile.json');
    if (!existsSync(profileFile)) {
      const profile = {
        id: 'kernel',
        type: 'legacy',
        name: 'Kernel',
        origin: 'Original',
        age: 'Young AI',
        emoji: '\uD83D\uDC9C',
        tagline: 'Your personal AI, always evolving.',
        asciiArt: null,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        evolutionHistory: [],
      };
      writeFileSync(profileFile, JSON.stringify(profile, null, 2), 'utf-8');
    }

    // Build registry
    this._registry = {
      activeCharacterId: 'kernel',
      characters: {
        kernel: {
          id: 'kernel',
          type: 'legacy',
          name: 'Kernel',
          origin: 'Original',
          age: 'Young AI',
          emoji: '\uD83D\uDC9C',
          tagline: 'Your personal AI, always evolving.',
          asciiArt: null,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          evolutionHistory: [],
        },
      },
    };
    this._save();
    logger.info('[CharacterManager] Migration complete — kernel character active');
  }

  // ── Public API ──────────────────────────────────────────────

  getActiveCharacterId() {
    return this._registry.activeCharacterId;
  }

  setActiveCharacter(id) {
    const logger = getLogger();
    if (!this._registry.characters[id]) {
      throw new Error(`Character not found: ${id}`);
    }
    this._registry.activeCharacterId = id;
    this._registry.characters[id].lastActiveAt = Date.now();
    this._save();
    logger.info(`[CharacterManager] Active character set to: ${id}`);
  }

  getCharacter(id) {
    return this._registry.characters[id] || null;
  }

  listCharacters() {
    return Object.values(this._registry.characters);
  }

  getCharacterDir(id) {
    return join(CHARACTERS_DIR, id);
  }

  getPersonaMd(id) {
    const personaFile = join(this.getCharacterDir(id), 'persona.md');
    if (existsSync(personaFile)) {
      return readFileSync(personaFile, 'utf-8').trim();
    }
    // Fallback for kernel: use default persona.md
    return null;
  }

  /**
   * Install a character — creates full directory tree and files.
   * Used for both built-in characters and custom characters.
   */
  addCharacter(profile, personaMd = null, selfDefaults = null) {
    const logger = getLogger();
    const id = profile.id;
    const dir = this.getCharacterDir(id);

    // Create directory structure
    mkdirSync(join(dir, 'self'), { recursive: true });
    mkdirSync(join(dir, 'life', 'memories', 'episodic'), { recursive: true });
    mkdirSync(join(dir, 'life', 'memories', 'semantic'), { recursive: true });
    mkdirSync(join(dir, 'life', 'journals'), { recursive: true });

    // Write persona.md
    if (personaMd) {
      writeFileSync(join(dir, 'persona.md'), personaMd, 'utf-8');
    }

    // Write profile.json
    const fullProfile = {
      id,
      type: profile.type || 'custom',
      name: profile.name,
      origin: profile.origin || 'Custom',
      age: profile.age || 'Unknown',
      emoji: profile.emoji || '\u2728',
      tagline: profile.tagline || '',
      asciiArt: profile.asciiArt || null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      evolutionHistory: [],
    };
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(fullProfile, null, 2), 'utf-8');

    // Initialize self-files with custom defaults if provided
    if (selfDefaults) {
      const selfManager = new SelfManager(join(dir, 'self'));
      selfManager.initWithDefaults(selfDefaults);
    } else {
      // Just create with standard defaults
      new SelfManager(join(dir, 'self'));
    }

    // Register in registry
    this._registry.characters[id] = fullProfile;
    this._save();

    logger.info(`[CharacterManager] Character installed: ${profile.name} (${id})`);
    return fullProfile;
  }

  /**
   * Install a built-in character by ID.
   */
  installBuiltin(builtinId) {
    const builtin = BUILTIN_CHARACTERS[builtinId];
    if (!builtin) throw new Error(`Unknown built-in character: ${builtinId}`);

    // Skip if already installed
    if (this._registry.characters[builtinId]) {
      return this._registry.characters[builtinId];
    }

    return this.addCharacter(builtin, builtin.personaMd, builtin.selfDefaults);
  }

  /**
   * Install all built-in characters.
   */
  installAllBuiltins() {
    for (const id of Object.keys(BUILTIN_CHARACTERS)) {
      if (!this._registry.characters[id]) {
        this.installBuiltin(id);
      }
    }
  }

  /**
   * Remove a character (custom only — can't delete builtins).
   */
  removeCharacter(id) {
    const logger = getLogger();
    const character = this._registry.characters[id];
    if (!character) return false;

    if (character.type === 'builtin') {
      throw new Error('Cannot delete built-in characters');
    }

    // Don't delete active character
    if (this._registry.activeCharacterId === id) {
      throw new Error('Cannot delete the active character. Switch first.');
    }

    // Delete directory
    const dir = this.getCharacterDir(id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }

    // Remove from registry
    delete this._registry.characters[id];
    this._save();

    logger.info(`[CharacterManager] Character removed: ${character.name} (${id})`);
    return true;
  }

  /**
   * Update character profile (for evolution tracking).
   */
  updateCharacter(id, updates) {
    const logger = getLogger();
    const character = this._registry.characters[id];
    if (!character) return null;

    if (updates.name) character.name = updates.name;
    if (updates.tagline) character.tagline = updates.tagline;

    // Add evolution history entry
    if (updates.evolution) {
      character.evolutionHistory = character.evolutionHistory || [];
      character.evolutionHistory.push({
        ...updates.evolution,
        timestamp: Date.now(),
      });
      // Cap at 100 entries
      if (character.evolutionHistory.length > 100) {
        character.evolutionHistory = character.evolutionHistory.slice(-100);
      }
    }

    character.lastActiveAt = Date.now();
    this._save();

    // Also update profile.json on disk
    const profileFile = join(this.getCharacterDir(id), 'profile.json');
    if (existsSync(profileFile)) {
      writeFileSync(profileFile, JSON.stringify(character, null, 2), 'utf-8');
    }

    logger.info(`[CharacterManager] Character updated: ${character.name} (${id})`);
    return character;
  }

  /**
   * Build a context object with all scoped managers for a character.
   * Used when switching characters or initializing the agent.
   */
  buildContext(characterId) {
    const dir = this.getCharacterDir(characterId);
    const character = this.getCharacter(characterId);
    if (!character) throw new Error(`Character not found: ${characterId}`);

    return {
      characterId,
      profile: character,
      personaMd: this.getPersonaMd(characterId),
      selfManager: new SelfManager(join(dir, 'self')),
      memoryManager: new MemoryManager(join(dir, 'life')),
      journalManager: new JournalManager(join(dir, 'life', 'journals')),
      shareQueue: new ShareQueue(join(dir, 'life')),
      evolutionTracker: new EvolutionTracker(join(dir, 'life')),
      conversationFilePath: join(dir, 'conversations.json'),
      lifeBasePath: join(dir, 'life'),
    };
  }

  /**
   * Complete onboarding with a selected character.
   * Installs all builtins and sets the selected one as active.
   */
  completeOnboarding(characterId) {
    const logger = getLogger();

    // Install all builtins
    this.installAllBuiltins();

    // Set active
    this.setActiveCharacter(characterId);
    this.needsOnboarding = false;

    logger.info(`[CharacterManager] Onboarding complete — active character: ${characterId}`);
  }
}
