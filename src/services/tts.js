import axios from 'axios';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

const CACHE_DIR = join(homedir(), '.kernelbot', 'tts-cache');
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // ElevenLabs "George" voice
const MAX_TEXT_LENGTH = 5000; // ElevenLabs limit

/**
 * Text-to-Speech service using ElevenLabs API.
 * Converts text to OGG/opus audio compatible with Telegram voice messages.
 */
export class TTSService {
  constructor(config = {}) {
    this.apiKey = config.elevenlabs?.api_key || process.env.ELEVENLABS_API_KEY || null;
    this.voiceId = config.elevenlabs?.voice_id || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    this.enabled = config.voice?.tts_enabled !== false && !!this.apiKey;
    this.logger = getLogger();

    // Ensure cache directory exists
    if (this.enabled) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
  }

  /** Check if TTS is available. */
  isAvailable() {
    return this.enabled && !!this.apiKey;
  }

  /**
   * Convert text to an OGG/opus audio buffer.
   * Returns the file path to the generated audio, or null on failure.
   */
  async synthesize(text) {
    if (!this.isAvailable()) return null;
    if (!text || text.trim().length === 0) return null;

    // Truncate if too long
    const cleanText = text.slice(0, MAX_TEXT_LENGTH).trim();

    // Check cache
    const cacheKey = this._cacheKey(cleanText, this.voiceId);
    const cachedPath = join(CACHE_DIR, `${cacheKey}.ogg`);
    if (existsSync(cachedPath)) {
      this.logger.debug(`[TTS] Cache hit: ${cacheKey}`);
      return cachedPath;
    }

    try {
      this.logger.info(`[TTS] Synthesizing ${cleanText.length} chars with voice ${this.voiceId}`);

      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
        {
          text: cleanText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        },
        {
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': this.apiKey,
          },
          responseType: 'arraybuffer',
          timeout: 30_000,
        },
      );

      // ElevenLabs returns MP3 by default when Accept: audio/mpeg
      // We write it as-is; Telegram accepts MP3 for voice messages via sendVoice
      // when sent with the right content type
      const audioBuffer = Buffer.from(response.data);

      if (audioBuffer.length < 100) {
        this.logger.warn('[TTS] Response too small, likely an error');
        return null;
      }

      // Cache the result
      writeFileSync(cachedPath, audioBuffer);
      this.logger.info(`[TTS] Synthesized and cached: ${cachedPath} (${audioBuffer.length} bytes)`);

      return cachedPath;
    } catch (err) {
      if (err.response) {
        const errBody = err.response.data instanceof Buffer
          ? err.response.data.toString('utf-8').slice(0, 200)
          : JSON.stringify(err.response.data).slice(0, 200);
        this.logger.error(`[TTS] API error ${err.response.status}: ${errBody}`);
      } else {
        this.logger.error(`[TTS] Request failed: ${err.message}`);
      }
      return null;
    }
  }

  /** Generate a deterministic cache key from text + voice. */
  _cacheKey(text, voiceId) {
    return createHash('sha256').update(`${voiceId}:${text}`).digest('hex').slice(0, 16);
  }

  /** Clear the TTS cache. */
  clearCache() {
    try {
      const files = readdirSync(CACHE_DIR);
      for (const file of files) {
        unlinkSync(join(CACHE_DIR, file));
      }
      this.logger.info(`[TTS] Cache cleared (${files.length} files)`);
    } catch {
      // Cache dir may not exist yet
    }
  }
}
