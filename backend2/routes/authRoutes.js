import express from 'express';
const router = express.Router();
import bcrypt from 'bcryptjs';
import passport from 'passport';
import mongoose from 'mongoose';
import User from '../Models/userModel.js';



// Register Route
router.post('/register', (req, res) => {
  const { email, password } = req.body;

  // Simple validation
  if (!email || !password) {
    return res.status(400).json({ msg: 'Please enter all fields' });
  }

  // Check if MongoDB is connected
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ msg: 'Database not available. Please try again later.' });
  }

  // Convert email to lowercase for case-insensitive comparison
  const emailLowerCase = email.toLowerCase();
  
  User.findOne({ email: { $regex: new RegExp('^' + emailLowerCase + '$', 'i') } })
    .then(user => {
      if (user) {
        return res.status(400).json({ msg: 'Email already exists' });
      }

      const newUser = new User({
        email: emailLowerCase, // Store email in lowercase
        password
      });

      // Hash password before saving
      bcrypt.genSalt(10, (err, salt) => {
        if (err) {
          console.error('Salt generation error:', err);
          return res.status(500).json({ msg: 'Registration error' });
        }
        
        bcrypt.hash(newUser.password, salt, (err, hash) => {
          if (err) {
            console.error('Password hashing error:', err);
            return res.status(500).json({ msg: 'Registration error' });
          }
          
          newUser.password = hash;
          newUser.save()
            .then(user => {
              res.status(201).json({
                success: true,
                msg: 'User registered successfully',
                userId: user.id
              });
            })
            .catch(err => {
              console.error('User save error:', err);
              res.status(500).json({ msg: 'Registration error' });
            });
        });
      });
    })
    .catch(err => {
      console.error('User find error:', err);
      res.status(500).json({ msg: 'Registration error' });
    });
});

// Login Route
router.post('/login', (req, res, next) => {
  const { email, password } = req.body;

  // Simple validation
  if (!email || !password) {
    return res.status(400).json({ msg: 'Please enter all fields' });
  }

  // Convert email to lowercase for consistency
  const emailLowerCase = email.toLowerCase();
  
  // Check if MongoDB is connected
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ msg: 'Database not available. Please try again later.' });
  }
  
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      console.error('Passport authentication error:', err);
      return res.status(500).json({ msg: 'Authentication error' });
    }
    if (!user) {
      return res.status(400).json({ msg: info.message || 'Invalid credentials' });
    }
    
    req.logIn(user, (err) => {
      if (err) {
        console.error('Login error:', err);
        return res.status(500).json({ msg: 'Login error' });
      }
      res.status(200).json({ 
        success: true, 
        msg: 'Logged in successfully', 
        user: { id: user.id, email: user.email }
      });
    });
  })(req, res, next);
});

// Logout Route
router.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.status(200).json({ success: true, msg: 'Logged out successfully' });
    });
});

export default router;