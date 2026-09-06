/**
 * Process entry point. Configuration validation, database connection, listen.
 *
 * v1 hardcoded port 8080, logged the Gemini API key to stdout on every boot,
 * and continued running when MongoDB was unreachable.
 */
import { createApp } from './src/app.js';
import { connectDatabase } from './src/config/database.js';
import config, { assertValidConfig } from './src/config/env.js';

async function main() {
  assertValidConfig();
  await connectDatabase();

  createApp().listen(config.port, () => {
    console.log(`Niyantrana API listening on port ${config.port} [${config.env}]`);
    console.log(`Inference service: ${config.inferenceServiceUrl}`);
    console.log(`Allowed origins: ${config.corsOrigins.join(', ')}`);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error.message);
  process.exit(1);
});
