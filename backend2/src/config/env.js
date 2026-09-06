/**
 * Centralised, validated environment configuration.
 *
 * Refactoring applied: Extract Class + Replace Magic Number with Symbolic Constant.
 *
 * Previously `process.env` was read at four unrelated call sites, the port was
 * the literal 8080 hardcoded in server.js, CORS was the literal
 * 'http://localhost:5173', and the session secret silently fell back to
 * 'a secret key for the hackathon'. Configuration is now resolved once, here,
 * and a production boot fails loudly rather than running insecurely.
 */
import dotenv from 'dotenv';

dotenv.config();

const bool = (value, fallback = false) =>
  value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,
  port: Number(process.env.PORT) || 8080,

  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/niyantrana',

  sessionSecret: process.env.SESSION_SECRET,
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS) || 24 * 60 * 60 * 1000,

  // Comma-separated list so preview deployments can be allowed without a redeploy.
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',').map((o) => o.trim()).filter(Boolean),

  inferenceServiceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8000',
  inferenceTimeoutMs: Number(process.env.ML_TIMEOUT_MS) || 15000,

  geminiApiKey: process.env.GEMINI_API_KEY,

  fitbit: {
    clientId: process.env.FITBIT_CLIENT_ID,
    clientSecret: process.env.FITBIT_CLIENT_SECRET,
    redirectUri: process.env.FITBIT_REDIRECT_URI,
  },

  trustProxy: bool(process.env.TRUST_PROXY, isProduction),
};

/**
 * Fail fast on misconfiguration rather than booting into an insecure state.
 * The v1 server started happily with a known-public session secret.
 */
export function assertValidConfig() {
  const problems = [];

  if (!config.sessionSecret) {
    problems.push('SESSION_SECRET is required');
  } else if (config.sessionSecret.length < 16) {
    problems.push('SESSION_SECRET must be at least 16 characters');
  }

  if (config.isProduction) {
    if (config.corsOrigins.includes('*')) problems.push('CORS_ORIGIN must not be * in production');
    if (config.mongoUri.includes('localhost')) problems.push('MONGO_URI still points at localhost');
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

export default config;
