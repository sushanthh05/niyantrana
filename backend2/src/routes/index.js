/**
 * Route table.
 *
 * Refactoring applied: Extract Class. Routing is now declarative wiring only;
 * handlers live in controllers and rules live in services. asyncHandler removes
 * the try/catch that was copy-pasted into every v1 handler.
 */
import { Router } from 'express';

import * as authController from '../controllers/authController.js';
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

// --- Risk assessment ---
router.post('/api/predict', authenticate, asyncHandler(riskController.assess));
router.post('/api/recommend', authenticate, asyncHandler(riskController.recommend));
router.get('/api/inference/health', asyncHandler(riskController.inferenceHealth));

export default router;
