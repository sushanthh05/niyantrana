/**
 * MongoDB connection.
 *
 * v1 logged the connection failure and carried on, so the server booted with a
 * dead database and every route failed at request time instead of at startup.
 * Connection failure is now fatal, which is what a health check expects.
 */
import mongoose from 'mongoose';

import config from './env.js';

export async function connectDatabase(uri = config.mongoUri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('MongoDB connected');
  return mongoose.connection;
}

export function databaseStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return states[mongoose.connection.readyState] ?? 'unknown';
}

export default connectDatabase;
