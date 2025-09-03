import dotenv from 'dotenv';
// Load env variables
dotenv.config();
console.log("My Gemini Key Is:",process.env.GEMINI_API_KEY);

import express from 'express';
import mongoose from 'mongoose';

import session from 'express-session';
import passport from 'passport';
import MongoStore from 'connect-mongo';
import passportConfig from './config/passport.js'; // You need to import the function
import authRoutes from './routes/authRoutes.js';
import apiRoutes from './routes/apiRoutes.js';
import userRoutes from './routes/userRoutes.js'; 
import cors from 'cors';


// Passport Config
passportConfig(passport);

// Initialize Express app
const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:5173', // Your React app's address
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Database Connection ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/niyantrana';

// Try to connect to MongoDB, but don't exit if it fails
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected successfully.'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    console.log('Please make sure MongoDB is running on localhost:27017');
    console.log('The server will start but authentication features may not work properly.');
    console.log('To install MongoDB: https://docs.mongodb.com/manual/installation/');
  });

// --- Session Middleware ---
let sessionStore;
try {
  sessionStore = MongoStore.create({ mongoUrl: MONGO_URI });
} catch (error) {
  console.log('MongoDB session store not available, using memory store');
  sessionStore = null;
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'a secret key for the hackathon', // Replace with a real secret in production
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: false, // Set to true in production with HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// --- Passport Middleware ---
app.use(passport.initialize());
app.use(passport.session());

// --- Basic Route ---
app.get('/', (req, res) => {
  res.json({ 
    message: 'Backend server is running!',
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// --- API Routes ---
// const authRoutes = require('./routes/authRoutes');
// const apiRoutes = require('./routes/apiRoutes'); 
app.use('/auth', authRoutes);
app.use('/api', apiRoutes); // We will add this in the next step
app.use('/api/user', userRoutes);



// --- Start the Server ---
const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});