/**
 * HTTP client for the Niyantrana API.
 *
 * Replaces a 772-line mock service whose header read "Mock API Service for
 * Frontend-Only Operation". That file fabricated health data in twenty places:
 * `riskScore: Math.floor(Math.random() * 100)` presented as an AI risk
 * assessment, and invented cholesterol, glucose and haemoglobin values returned
 * as if extracted from an uploaded lab report.
 *
 * Six of its eight namespaces (healthAPI, assessmentAPI, mlAPI, chatAPI,
 * healthCheckAPI, uploadAPI) were imported by nothing at all -- roughly 600
 * lines of dead code that also constituted the project's worst safety problem.
 *
 * Auth is session cookies, not bearer tokens: the backend uses Passport
 * sessions, so every request sends `credentials: 'include'`. The old file kept
 * `authToken` / `refreshToken` in localStorage, which was the wrong shape for
 * the backend that actually exists.
 *
 * NOTE: the frontend is being rebuilt. This module exists so the current tree
 * contains no fabricated health data, not as the final design.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080')
  .replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (networkError) {
    throw new ApiError(`Cannot reach the API at ${API_BASE}`, 0, networkError.message);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // Surfaced with its real status. Nothing is substituted on failure -- the
    // whole point of this rewrite.
    throw new ApiError(payload?.message || `Request failed (${response.status})`,
      response.status, payload?.details);
  }
  return payload;
}

export const auth = {
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
};

export const user = {
  status: () => request('/api/user/status'),
  saveProfile: (profile) => request('/api/user/profile', { method: 'POST', body: profile }),
  updateWeight: (weight) => request('/api/user/weight', { method: 'POST', body: { weight } }),
  wearable: (days = 14) => request(`/api/user/wearable?days=${days}`),
};

export const logs = {
  meals: (limit = 50) => request(`/api/logs/meals?limit=${limit}`),
  logMeal: (meal) => request('/api/logs/meals', { method: 'POST', body: meal }),
  dailyMacros: () => request('/api/logs/macros/daily'),
  logVitals: (reading) => request('/api/logs/vitals', { method: 'POST', body: reading }),
  vitals: () => request('/api/logs/vitals'),
  logActivity: (activity) => request('/api/logs/activity', { method: 'POST', body: activity }),
  searchFood: (query) => request(`/api/food/search?q=${encodeURIComponent(query)}`),
};

export const risk = {
  /**
   * Multi-condition assessment.
   *
   * Every score in the response carries `provenance` and `basis`. If the
   * inference service is unreachable this throws with status 503 -- it never
   * returns a plausible-looking number.
   */
  assess: () => request('/api/predict', { method: 'POST', body: {} }),
  recommendMeal: (meal) => request('/api/recommend', { method: 'POST', body: { meal } }),
};

export const wearable = {
  formats: () => request('/api/wearable/formats'),
  import: (data, source = 'import') => request('/api/wearable/import', { method: 'POST', body: { data, source } }),
  loadDemo: (days = 90) => request('/api/wearable/demo', { method: 'POST', body: { days } }),
};

export const chat = {
  send: (message, history = []) => request('/api/chat', { method: 'POST', body: { message, history } }),
};

export default { auth, user, logs, risk, wearable, chat, API_BASE };
