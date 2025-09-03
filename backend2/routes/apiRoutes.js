import express from 'express';
import axios from 'axios';
import User from '../Models/userModel.js'; // Make sure to import the User model

const router = express.Router();

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) { return next(); }
  res.status(401).json({ msg: 'You are not authorized' });
};

// --- (Gemini initialization is kept here for when we uncomment it) ---
// import { GoogleGenerativeAI } from '@google/generative-ai';
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest"});

router.post('/predict', isAuthenticated, async (req, res) => {
  try {
    // --- 1. Fetch ALL Data from the Database ---
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ msg: "User not found." });
    }

    const staticData = user.staticData;
    let watch_data = user.watchHistory; 
    
    // --- MOCK FALLBACK for testing if watchHistory is empty ---
    if (!watch_data || watch_data.length < 1) {
      console.log("--- MOCK MODE: watchHistory is empty, using fake watch data ---");
      watch_data = Array.from({ length: 14 }, (_, i) => ({
        day: i + 1,
        daily_steps: 5000 + (i * 100),
        active_calories: 300 + (i * 5),
        sleep_hours: 6.5,
        // Add other mock fields your model needs
      }));
    }

    // --- 2. Construct the user_data payload for the ML model ---
    // This part requires you to define how to get all the necessary fields.
    // We'll construct a simplified version for now.
    const user_data_for_model = {
      age: staticData.age,
      gender: staticData.gender,
      height: staticData.height,
      weight: staticData.weight, // Get weight from static data
      // Calculate BMI
      bmi: (staticData.weight / ((staticData.height / 100) ** 2)),
      waist: staticData.waist,
      // ... plus all other fields your model requires like calorie_intake, etc.
    };
    
         // --- 3. Call the Python ML Service to get TG and GGT ---
     let biomarkers;
     try {
       console.log('--- REAL MODE: Calling Python ML Service ---');
       const mlServiceUrl = 'http://localhost:5000/predict'; 
       const mlResponse = await axios.post(mlServiceUrl, { 
         user_data: user_data_for_model, 
         watch_data: watch_data 
       });
       
       // Handle different response formats from ML service
       const mlData = mlResponse.data;
       if (mlData.predicted_triglycerides && mlData.predicted_ggt) {
         // Convert from ML service format to our format
         biomarkers = {
           TG: mlData.predicted_triglycerides,
           GGT: mlData.predicted_ggt
         };
       } else if (mlData.TG && mlData.GGT) {
         // Already in our format
         biomarkers = mlData;
       } else {
         // Fallback to mock data
         biomarkers = {
           TG: 150 + Math.floor(Math.random() * 50),
           GGT: 30 + Math.floor(Math.random() * 40)
         };
       }
       console.log('Processed biomarkers:', biomarkers);
     } catch (mlError) {
       console.log('--- MOCK MODE: ML service not available, using mock biomarkers ---');
       // Fallback to mock data if ML service is not available
       biomarkers = {
         TG: 150 + Math.floor(Math.random() * 50), // Random value between 150-200
         GGT: 30 + Math.floor(Math.random() * 40)  // Random value between 30-70
       };
       console.log('Using mock biomarkers:', biomarkers);
     }

         // --- 4. Calculate the FLI Score ---
     const triglycerides = biomarkers.TG;
     const ggt = biomarkers.GGT;
     const bmi = user_data_for_model.bmi;
     const waist = staticData.waist;

     let fliScore = null;
     try {
       // Ensure all values are valid numbers and positive for log calculation
       if (triglycerides > 0 && ggt > 0 && bmi > 0 && waist > 0) {
         const exponent = (0.953 * Math.log(triglycerides)) + (0.139 * bmi) + (0.718 * Math.log(ggt)) + (0.053 * waist) - 15.745;
         const probability = Math.exp(exponent) / (1 + Math.exp(exponent));
         fliScore = Math.round(probability * 100);
         console.log('Calculated FLI Score:', fliScore);
       } else {
         console.log('Invalid values for FLI calculation:', { triglycerides, ggt, bmi, waist });
         fliScore = 50; // Default fallback value
       }
     } catch (error) {
       console.log('Error calculating FLI score:', error);
       fliScore = 50; // Default fallback value
     }

    // --- 5. Prepare Final Response ---
    const mockActionPlan = {
      disclaimer: "This is a sample AI-generated plan. Please consult a doctor.",
      dietPlan: { title: "Sample Diet Plan", breakfast: "Oats", lunch: "Salad", dinner: "Soup" },
      exercisePlan: { title: "Sample Exercise Plan", frequency: "3-5 times/week", duration: "30 mins" }
    };

    const finalResponse = {
      prediction: {
        fliScore: fliScore,
        biomarkers: biomarkers
      },
      actionPlan: mockActionPlan 
    };

    res.status(200).json(finalResponse);

  } catch (error) {
    console.error('Error in prediction route:', error.response ? error.response.data : error.message);
    res.status(500).json({ msg: 'Server error during prediction' });
  }
});

export default router;