/**
 * Adapter over the Python inference service.
 *
 * Patterns applied: Adapter (translates between this service's vocabulary and
 * the model service's wire format) and Remove Middle Man (the route no longer
 * reaches through to axios itself).
 *
 * The behaviour this replaces is the single worst defect in v1: apiRoutes.js
 * wrapped the ML call in a try/catch that, on ANY failure, substituted
 * `TG: 150 + Math.random() * 50` and returned HTTP 200. There were three such
 * fallbacks. A caller had no way to distinguish a real prediction from a random
 * number, in a health application.
 *
 * This client throws. It never invents a value.
 */
import axios from 'axios';

import config from '../config/env.js';
import { InferenceUnavailableError, ValidationError } from '../domain/errors.js';

export class InferenceClient {
  constructor({ baseUrl = config.inferenceServiceUrl,
                timeout = config.inferenceTimeoutMs,
                coldStartTimeout = config.inferenceColdStartTimeoutMs,
                http = axios } = {}) {
    this.baseUrl = InferenceClient.normalizeBaseUrl(baseUrl);
    this.timeout = timeout;
    this.coldStartTimeout = coldStartTimeout;
    this.http = http;
  }

  /**
   * Accept a bare hostname as well as a full URL.
   *
   * Render blueprints wire services together with `fromService` +
   * `property: host`, which yields `niyantrana-inference.onrender.com` with no
   * scheme. Without this, every request would be built as
   * `niyantrana-inference.onrender.com/predict` and fail to parse -- so the
   * blueprint could not connect the two services without manual editing.
   */
  static normalizeBaseUrl(value) {
    const trimmed = String(value || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // A bare host is assumed to be TLS-terminated, except on localhost.
    const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(trimmed)
      ? 'http' : 'https';
    return `${scheme}://${trimmed}`;
  }

  /**
   * Whether a failure looks like the model service being asleep rather than
   * broken. Only these are worth a second, longer attempt.
   */
  static #isColdStart(error) {
    if (error.response) return false;          // it answered, so it is awake
    return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
      'EAI_AGAIN'].includes(error.code);
  }

  async #send(path, payload, timeout) {
    const response = await this.http.post(`${this.baseUrl}${path}`, payload, {
      timeout,
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data;
  }

  async #post(path, payload) {
    try {
      return await this.#send(path, payload, this.timeout);
    } catch (error) {
      // A 4xx means we sent something invalid; surface it as a client error
      // rather than blaming the downstream service.
      const status = error.response?.status;
      if (status >= 400 && status < 500) {
        throw new ValidationError(
          error.response.data?.detail || 'The inference service rejected the request',
          error.response.data,
        );
      }

      // Retry ONCE, and only for a failure that looks like a sleeping service.
      // A 5xx is not retried: the service answered, so repeating the call just
      // doubles the latency before reporting the same fault.
      if (!InferenceClient.#isColdStart(error) || this.coldStartTimeout <= this.timeout) {
        throw new InferenceUnavailableError(error.code || error.message);
      }

      console.warn(`[inference] ${error.code || error.message}; retrying once with `
        + `${this.coldStartTimeout}ms in case the service is waking from idle`);
      try {
        return await this.#send(path, payload, this.coldStartTimeout);
      } catch (retryError) {
        throw new InferenceUnavailableError(
          `${retryError.code || retryError.message} (after a cold-start retry)`);
      }
    }
  }

  /**
   * Returns a full risk assessment, or throws. Never a fabricated score.
   *
   * `history` is what makes trajectories possible. The inference service has
   * accepted it since the trajectory feature was built, but this client did not
   * send it -- so every response came back with an empty `trajectories` array
   * and the risk-over-time feature was unreachable through the API. Caught by
   * the demo-seeding test asserting that 90 days of history yields trends.
   */
  async assessRisk({ profile, wearableWindow, history, measured }) {
    const data = await this.#post('/predict', {
      user_data: profile,
      watch_data: wearableWindow,
      history: history?.length ? history : undefined,
      measured: measured || null,
    });

    if (!data || !Array.isArray(data.risks) || !data.provenance) {
      // v1 responded to an unrecognised shape by substituting random numbers.
      throw new InferenceUnavailableError('Malformed response from inference service');
    }
    return data;
  }

  async recommendMeal({ userContext, meal }) {
    return this.#post('/recommend', { user_context: userContext, original_meal: meal });
  }

  async health() {
    try {
      const { data } = await this.http.get(`${this.baseUrl}/health`, { timeout: 5000 });
      return { reachable: true, ...data };
    } catch (error) {
      return { reachable: false, reason: error.code || error.message };
    }
  }
}

export default new InferenceClient();
