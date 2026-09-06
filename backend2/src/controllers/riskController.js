/** HTTP adapters for risk assessment and meal recommendation. */
import inferenceClient from '../clients/inferenceClient.js';
import riskService from '../services/riskService.js';

export async function assess(req, res) {
  const assessment = await riskService.assess(req.user.id, {
    dietTotals: req.body?.dietTotals,
    measured: req.body?.measured,
  });
  res.json(assessment);
}

export async function recommend(req, res) {
  res.json(await riskService.recommendMeal(req.user.id, req.body?.meal));
}

export async function inferenceHealth(_req, res) {
  const health = await inferenceClient.health();
  res.status(health.reachable ? 200 : 503).json(health);
}
