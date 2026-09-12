/** HTTP adapters for meal, vitals and activity logging. */
import chatService from '../services/chatService.js';
import loggingService from '../services/loggingService.js';

// --- Meals ------------------------------------------------------------------
export async function logMeal(req, res) {
  res.status(201).json(await loggingService.logMeal(req.user.id, req.body));
}

export async function listMeals(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ meals: await loggingService.listMeals(req.user.id, { limit }) });
}

export async function deleteMeal(req, res) {
  res.json(await loggingService.deleteMeal(req.user.id, req.params.id));
}

export async function dailyMacros(req, res) {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const totals = await loggingService.dailyMacroTotals(req.user.id, date);
  // null, not a zeroed object: "logged nothing" is not "ate nothing".
  res.json({ totals, logged: totals !== null });
}

export async function macroTrend(req, res) {
  const days = Math.min(Number(req.query.days) || 14, 90);
  res.json({ days, trend: await loggingService.macroTrend(req.user.id, days) });
}

// --- Vitals -----------------------------------------------------------------
export async function logVitals(req, res) {
  res.status(201).json(await loggingService.logVitals(req.user.id, req.body));
}

export async function listVitals(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ readings: await loggingService.listVitals(req.user.id, { limit }) });
}

// --- Activity ---------------------------------------------------------------
export async function logActivity(req, res) {
  res.status(201).json(await loggingService.logActivity(req.user.id, req.body));
}

// --- Chat -------------------------------------------------------------------
export async function chat(req, res) {
  const { message, history } = req.body ?? {};
  res.json(await chatService.reply(req.user.id, message, history));
}
