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
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;

/**
 * Candidate models, newest first.
 *
 * Not speculative generality -- Google shipped three Flash generations inside a
 * year and pulled `gemini-2.5-flash` from new users BEFORE its published
 * October 2026 date. Production returned `404: this model is no longer
 * available to new users` on a name that was current when it was written.
 *
 * The first candidate that answers is cached for the process. `GEMINI_MODEL`
 * pins a single model and disables the chain.
 */
const MODEL_CANDIDATES = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

export class GeminiUnavailableError extends ServiceUnavailableError {
  constructor(reason) {
    super('The assistant is temporarily unavailable.', { reason });
    this.provenance = 'unavailable';
  }
}

export class GeminiClient {
  constructor({ apiKey = config.geminiApiKey, models = MODEL_CANDIDATES,
    timeoutMs = DEFAULT_TIMEOUT_MS, http = fetch } = {}) {
    this.apiKey = apiKey;
    this.models = Array.isArray(models) ? models : [models];
    this.timeoutMs = timeoutMs;
    this.http = http;
    this.resolvedModel = null;
  }

  /** The model in use, or the next one to be tried. */
  get model() {
    return this.resolvedModel ?? this.models[0];
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

    // Try the cached model first, then the rest of the chain.
    const order = this.resolvedModel
      ? [this.resolvedModel]
      : this.models;
    let lastProblem = 'no candidate models configured';

    for (const model of order) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.http(`${ENDPOINT}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        // A network failure is not the model's fault; do not burn the chain.
        throw new GeminiUnavailableError(
          error.name === 'AbortError' ? 'timeout' : error.message);
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        if (this.resolvedModel !== model) {
          this.resolvedModel = model;
          console.log(`[gemini] using ${model}`);
        }
        return GeminiClient.extractText(await response.json());
      }

      const detail = await response.text().catch(() => '');
      lastProblem = `HTTP ${response.status}: ${detail.slice(0, 200)}`;

      // 404 / 400 on the model path means "that name is gone" -- try the next.
      // Anything else (401 bad key, 429 quota, 5xx) is not model-specific.
      if (![400, 404].includes(response.status)) break;
      console.warn(`[gemini] ${model} rejected (${response.status}); trying the next candidate`);
    }

    throw new GeminiUnavailableError(lastProblem);
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
