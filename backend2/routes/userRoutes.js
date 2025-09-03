import express from 'express';
import User from '../Models/userModel.js';
import Food from '../Models/foodModel.js';

const router = express.Router();

// Middleware to check if the user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ msg: 'You are not authorized' });
};

// Route to get the current user's status ('calibrating' or 'active')
// This is used by the frontend to decide which page to show
router.get('/status', isAuthenticated, (req, res) => {
  // req.user is made available by Passport.js after a user logs in
  // We also send back staticData so the frontend has it for the BMR calculation
  res.status(200).json({ status: req.user.status, staticData: req.user.staticData });
});

// Route to save the initial, one-time static data and calculate BMR
// This is the first step for a new user
router.post('/static-data', isAuthenticated, async (req, res) => {
  try {
    const { age, height, weight, gender, waist, has_hereditary_risk } = req.body;
    
    // Calculate BMR using Mifflin-St Jeor equation
    // BMR = (10 × weight) + (6.25 × height) - (5 × age) + 5 (for males) or -161 (for females)
    let bmr = (10 * weight) + (6.25 * height) - (5 * age);
    bmr += (gender === 'male' ? 5 : -161);
    const calculatedBMR = Math.round(bmr);
    
    // Find the logged-in user by their ID and update their staticData and status
    await User.findByIdAndUpdate(req.user.id, {
      'staticData.age': age,
      'staticData.height': height,
      'staticData.weight': weight,
      'staticData.gender': gender,
      'staticData.waist': waist,
      'staticData.has_hereditary_risk': has_hereditary_risk,
      'staticData.bmr': calculatedBMR,
      status: 'active' // Set user to active status immediately
    });

    res.status(200).json({ 
      msg: 'Static data saved successfully and BMR calculated.',
      bmr: calculatedBMR
    });
  } catch (error) {
    console.error('Error saving static data:', error);
    res.status(500).json({ msg: 'Server error.' });
  }
});



// Route to update weight and recalculate BMR
router.post('/update-weight', isAuthenticated, async (req, res) => {
  try {
    const { weight } = req.body;
    
    // Get current user data
    const user = await User.findById(req.user.id);
    if (!user || !user.staticData) {
      return res.status(404).json({ msg: 'User or static data not found.' });
    }

    // Recalculate BMR using Mifflin-St Jeor equation with new weight
    const { age, height, gender } = user.staticData;
    let bmr = (10 * weight) + (6.25 * height) - (5 * age);
    bmr += (gender === 'male' ? 5 : -161);
    const calculatedBMR = Math.round(bmr);
    
    // Update weight and BMR
    await User.findByIdAndUpdate(req.user.id, {
      'staticData.weight': weight,
      'staticData.bmr': calculatedBMR
    });

    res.status(200).json({ 
      msg: 'Weight updated and BMR recalculated successfully.',
      bmr: calculatedBMR
    });
  } catch (error) {
    console.error('Error updating weight:', error);
    res.status(500).json({ msg: 'Server error.' });
  }
});

// Smartwatch data endpoint
router.get('/smartwatch-data', isAuthenticated, async (req, res) => {
  try {
    // Get user's watch history from database
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ msg: 'User not found.' });
    }

    // If user has watch data, return the latest entry
    if (user.watchHistory && user.watchHistory.length > 0) {
      const latestData = user.watchHistory[user.watchHistory.length - 1];
      res.status(200).json(latestData);
    } else {
      // Return mock data for demo purposes
      const mockData = {
        daily_steps: 8432,
        active_calories: 456,
        sleep_hours: 7.5,
        heart_rate: 72,
        heart_rate_variability: 45,
        last_sync: new Date().toISOString()
      };
      res.status(200).json(mockData);
    }
  } catch (error) {
    console.error('Error fetching smartwatch data:', error);
    res.status(500).json({ msg: 'Server error during smartwatch data fetch' });
  }
});

// Update smartwatch data endpoint
router.post('/smartwatch-data', isAuthenticated, async (req, res) => {
  try {
    const { daily_steps, active_calories, sleep_hours, heart_rate, heart_rate_variability } = req.body;
    
    const watchData = {
      date: new Date(),
      daily_steps: daily_steps || 0,
      active_calories: active_calories || 0,
      sleep_hours: sleep_hours || 0,
      heart_rate: heart_rate || 0,
      heart_rate_variability: heart_rate_variability || 0
    };

    // Add to user's watch history
    await User.findByIdAndUpdate(req.user.id, {
      $push: { watchHistory: watchData }
    });

    res.status(200).json({ msg: 'Smartwatch data updated successfully', data: watchData });
  } catch (error) {
    console.error('Error updating smartwatch data:', error);
    res.status(500).json({ msg: 'Server error during smartwatch data update' });
  }
});

// Food search endpoint
router.get('/food/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ msg: 'Please enter at least 2 characters to search' });
    }

    // Search for food items that match the query
    const foods = await Food.find({
      food_name: { $regex: q, $options: 'i' } // Case-insensitive search
    }).limit(10); // Limit to 10 results

    res.status(200).json(foods);
  } catch (error) {
    console.error('Error searching for food:', error);
    res.status(500).json({ msg: 'Server error during food search' });
  }
});

export default router;