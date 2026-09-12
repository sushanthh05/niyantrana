/**
 * Route table.
 *
 * Refactoring applied: Extract Class. Routing is now declarative wiring only;
 * handlers live in controllers and rules live in services. asyncHandler removes
 * the try/catch that was copy-pasted into every v1 handler.
 */
import { Router } from 'express';

import * as authController from '../controllers/authController.js';
import * as logController from '../controllers/logController.js';
import * as wearableController from '../controllers/wearableController.js';
import * as riskController from '../controllers/riskController.js';
import * as userController from '../controllers/userController.js';
import authenticate from '../middleware/authenticate.js';
import asyncHandler from '../middleware/asyncHandler.js';

const router = Router();

// --- Authentication ---
router.post('/auth/register', asyncHandler(authController.register));
router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.get('/auth/me', authenticate, authController.me);

// --- Profile and wearable data ---
router.get('/api/user/status', authenticate, asyncHandler(userController.getStatus));
router.post('/api/user/profile', authenticate, asyncHandler(userController.saveProfile));
router.post('/api/user/weight', authenticate, asyncHandler(userController.updateWeight));
router.get('/api/user/wearable', authenticate, asyncHandler(userController.getWearableData));
router.post('/api/user/wearable', authenticate, asyncHandler(userController.recordWearableData));

// Food search is authenticated; v1 left it open.
router.get('/api/food/search', authenticate, asyncHandler(userController.searchFood));

// --- Logging: meals, vitals, activity ---
router.post('/api/logs/meals', authenticate, asyncHandler(logController.logMeal));
router.get('/api/logs/meals', authenticate, asyncHandler(logController.listMeals));
router.delete('/api/logs/meals/:id', authenticate, asyncHandler(logController.deleteMeal));
router.get('/api/logs/macros/daily', authenticate, asyncHandler(logController.dailyMacros));
router.get('/api/logs/macros/trend', authenticate, asyncHandler(logController.macroTrend));

router.post('/api/logs/vitals', authenticate, asyncHandler(logController.logVitals));
router.get('/api/logs/vitals', authenticate, asyncHandler(logController.listVitals));

router.post('/api/logs/activity', authenticate, asyncHandler(logController.logActivity));

// --- Wearable import and demo seeding ---
// Import is the primary wearable path: every consumer API a solo developer
// could register for has closed. See services/wearableImportService.js.
router.get('/api/wearable/formats', wearableController.importFormats);
router.post('/api/wearable/import', authenticate, asyncHandler(wearableController.importWearableData));
router.post('/api/wearable/demo', authenticate, asyncHandler(wearableController.loadDemoData));

// --- Conversational assistant ---
// Server-side proxy: the Gemini key must never reach the browser, which is
// exactly what v1 did by inlining VITE_GEMINI_API_KEY into the bundle.
router.post('/api/chat', authenticate, asyncHandler(logController.chat));

// --- Risk assessment ---
router.post('/api/predict', authenticate, asyncHandler(riskController.assess));
router.post('/api/recommend', authenticate, asyncHandler(riskController.recommend));
router.get('/api/inference/health', asyncHandler(riskController.inferenceHealth));

export default router;
