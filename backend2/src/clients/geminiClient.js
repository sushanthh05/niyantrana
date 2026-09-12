/**
 * Adapter over the Gemini REST API.
 *
 * This exists so the API key never reaches the browser. v1 called Gemini
 * directly from the frontend with `VITE_GEMINI_API_KEY`, which Vite inlines
 * into the bundle -- anyone who opened devtools had the key, and could spend
 * the quota.
 *
 * Uses `fetch` from the Node runtime rather than the `google-generativeai`
 * SDK. The inference service made the same choice for image size; here the
 * reason is simpler: this is one HTTP POST and a dependency would be pure cost.
 */
import config from '../config/env.js';
import { ServiceUnavailableError, ValidationError } from '../domain/errors.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;

export class GeminiUnavailableError extends ServiceUnavailableError {
  constructor(reason) {
    super('The assistant is temporarily unavailable.', { reason });
    this.provenance = 'unavailable';
  }
}

export class GeminiClient {
  constructor({ apiKey = config.geminiApiKey, model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS, http = fetch } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.http = http;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * Generate a reply.
   *
   * @param {Array<{role: 'user'|'model', text: string}>} turns conversation so far
   * @param {string} systemPrompt grounding instructions
   */
  async generate(turns, systemPrompt) {
    if (!this.isConfigured) {
      throw new GeminiUnavailableError('GEMINI_API_KEY is not set');
    }
    if (!Array.isArray(turns) || turns.length === 0) {
      throw new ValidationError('At least one message is required');
    }

    const body = {
      contents: turns.map(({ role, text }) => ({
        role: role === 'model' ? 'model' : 'user',
        parts: [{ text }],
      })),
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
    };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.http(`${ENDPOINT}/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new GeminiUnavailableError(error.name === 'AbortError' ? 'timeout' : error.message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GeminiUnavailableError(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    return GeminiClient.extractText(await response.json());
  }

  /** Pull the reply out, distinguishing "empty" from "blocked by safety". */
  static extractText(payload) {
    const candidate = payload?.candidates?.[0];
    if (!candidate) {
      const blocked = payload?.promptFeedback?.blockReason;
      throw new GeminiUnavailableError(`no candidates (blockReason=${blocked || 'none'})`);
    }
    const text = (candidate.content?.parts || [])
      .map((part) => part.text || '').join('').trim();
    if (!text) {
      throw new GeminiUnavailableError(`empty response (finishReason=${candidate.finishReason})`);
    }
    return text;
  }
}

export default new GeminiClient();
