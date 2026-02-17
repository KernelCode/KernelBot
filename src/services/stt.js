import axios from 'axios';
import { createWriteStream, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { getLogger } from '../utils/logger.js';

/**
 * Speech-to-Text service.
 * Supports ElevenLabs STT and falls back to OpenAI Whisper.
 */
export class STTService {
  constructor(config = {}) {
    this.elevenLabsKey = config.elevenlabs?.api_key || process.env.ELEVENLABS_API_KEY || null;
    this.openaiKey = config.brain?.provider === 'openai'
      ? config.brain.api_key
      : process.env.OPENAI_API_KEY || null;
    this.enabled = config.voice?.stt_enabled !== false && !!(this.elevenLabsKey || this.openaiKey);
    this.logger = getLogger();
  }

  /** Check if STT is available. */
  isAvailable() {
    return this.enabled && !!(this.elevenLabsKey || this.openaiKey);
  }

  /**
   * Download a file from a URL to a temporary path.
   * Returns the local file path.
   */
  async downloadAudio(fileUrl) {
    const tmpPath = join(tmpdir(), `kernelbot-stt-${randomBytes(4).toString('hex')}.ogg`);

    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 30_000,
    });

    return new Promise((resolve, reject) => {
      const writer = createWriteStream(tmpPath);
      response.data.pipe(writer);
      writer.on('finish', () => resolve(tmpPath));
      writer.on('error', reject);
    });
  }

  /**
   * Transcribe an audio file to text.
   * Tries ElevenLabs first, falls back to OpenAI Whisper.
   * Returns the transcribed text, or null on failure.
   */
  async transcribe(filePath) {
    if (!this.isAvailable()) return null;

    // Try ElevenLabs STT first
    if (this.elevenLabsKey) {
      try {
        const result = await this._transcribeElevenLabs(filePath);
        if (result) return result;
      } catch (err) {
        this.logger.warn(`[STT] ElevenLabs failed, trying fallback: ${err.message}`);
      }
    }

    // Fall back to OpenAI Whisper
    if (this.openaiKey) {
      try {
        return await this._transcribeWhisper(filePath);
      } catch (err) {
        this.logger.error(`[STT] Whisper fallback also failed: ${err.message}`);
      }
    }

    return null;
  }

  /** Transcribe using ElevenLabs Speech-to-Text API. */
  async _transcribeElevenLabs(filePath) {
    this.logger.info(`[STT] Transcribing with ElevenLabs: ${filePath}`);

    const fileBuffer = readFileSync(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), 'audio.ogg');
    formData.append('model_id', 'scribe_v1');

    const response = await axios.post(
      'https://api.elevenlabs.io/v1/speech-to-text',
      formData,
      {
        headers: {
          'xi-api-key': this.elevenLabsKey,
        },
        timeout: 60_000,
      },
    );

    const text = response.data?.text?.trim();
    if (text) {
      this.logger.info(`[STT] ElevenLabs transcription: "${text.slice(0, 100)}"`);
    }
    return text || null;
  }

  /** Transcribe using OpenAI Whisper API. */
  async _transcribeWhisper(filePath) {
    this.logger.info(`[STT] Transcribing with Whisper: ${filePath}`);

    const fileBuffer = readFileSync(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), 'audio.ogg');
    formData.append('model', 'whisper-1');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${this.openaiKey}`,
        },
        timeout: 60_000,
      },
    );

    const text = response.data?.text?.trim();
    if (text) {
      this.logger.info(`[STT] Whisper transcription: "${text.slice(0, 100)}"`);
    }
    return text || null;
  }

  /** Clean up a temporary audio file. */
  cleanup(filePath) {
    try {
      unlinkSync(filePath);
    } catch {
      // Already cleaned up or doesn't exist
    }
  }
}
