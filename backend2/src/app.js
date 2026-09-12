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

import mongoose from 'mongoose';

import chatService from './services/chatService.js';

import config from './config/env.js';
import configurePassport from './config/passport.js';
import { databaseStatus } from './config/database.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

/**
 * Session store backed by the EXISTING mongoose connection.
 *
 * `MongoStore.create({ mongoUrl })` opens a second, independent MongoClient.
 * That doubles the connection count against a free Atlas tier for no benefit,
 * and its socket keeps the event loop alive so the process never exits -- which
 * is how this was found: the integration suite passed every assertion and then
 * hung until the runner timed out.
 */
function createSessionStore() {
  const client = mongoose.connection?.getClient?.();
  return client
    ? MongoStore.create({ client })
    : MongoStore.create({ mongoUrl: config.mongoUri });
}


export function createApp() {
  const app = express();

  // Render and similar platforms terminate TLS at a proxy; without this the
  // secure cookie is never set.
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '4mb' }));
  // Wearable exports arrive as raw CSV. text/csv must reach the route as a
  // string rather than being rejected by the JSON parser.
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: createSessionStore(),
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
      // Chat being unconfigured is not a failure: every other endpoint works.
      chat_enabled: chatService.isConfigured,
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
