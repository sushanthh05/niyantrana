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
                http = axios } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;
    this.http = http;
  }

  async #post(path, payload) {
    try {
      const response = await this.http.post(`${this.baseUrl}${path}`, payload, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' },
      });
      return response.data;
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
      throw new InferenceUnavailableError(error.code || error.message);
    }
  }

  /** Returns a full risk assessment, or throws. Never a fabricated score. */
  async assessRisk({ profile, wearableWindow, measured }) {
    const data = await this.#post('/predict', {
      user_data: profile,
      watch_data: wearableWindow,
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
