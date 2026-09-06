/**
 * Express application assembly.
 *
 * Refactoring applied: Extract Class. server.js previously mixed configuration,
 * database connection, session setup, route definitions and process startup in
 * one 102-line file. Building the app is now separate from running it, which is
 * what makes integration testing possible without binding a port.
 */
import MongoStore from 'connect-mongo';
import cors from 'cors';
import express from 'express';
import session from 'express-session';
import passport from 'passport';

import config from './config/env.js';
import configurePassport from './config/passport.js';
import { databaseStatus } from './config/database.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

export function createApp() {
  const app = express();

  // Render and similar platforms terminate TLS at a proxy; without this the
  // secure cookie is never set.
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: config.mongoUri }),
    cookie: {
      secure: config.isProduction,
      httpOnly: true,
      sameSite: config.isProduction ? 'none' : 'lax',
      maxAge: config.sessionMaxAgeMs,
    },
  }));

  configurePassport(passport);
  app.use(passport.initialize());
  app.use(passport.session());

  app.get('/health', (_req, res) => {
    const database = databaseStatus();
    res.status(database === 'connected' ? 200 : 503).json({
      status: database === 'connected' ? 'ok' : 'degraded',
      database,
      timestamp: new Date().toISOString(),
    });
  });

  app.use(routes);

  // Order matters: unmatched routes first, then the single error translator.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
