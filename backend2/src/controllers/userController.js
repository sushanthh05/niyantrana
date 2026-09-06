/** HTTP adapters for profile and wearable data. */
import foodRepository from '../repositories/foodRepository.js';
import { ValidationError } from '../domain/errors.js';
import userService from '../services/userService.js';

const MIN_SEARCH_LENGTH = 2;

export async function getStatus(req, res) {
  res.json(await userService.getStatus(req.user.id));
}

export async function saveProfile(req, res) {
  res.json({ success: true, staticData: await userService.saveProfile(req.user.id, req.body) });
}

export async function updateWeight(req, res) {
  res.json({ success: true, ...(await userService.updateWeight(req.user.id, req.body.weight)) });
}

export async function getWearableData(req, res) {
  const days = Number(req.query.days) || 14;
  const data = await userService.recentWearableData(req.user.id, days);
  // v1 returned a hardcoded object (8432 steps, 456 cal, 7.5h) when history was
  // empty. An empty history is now simply an empty list.
  res.json({ days: data.length, data });
}

export async function recordWearableData(req, res) {
  res.status(201).json(await userService.recordWearableData(req.user.id, req.body));
}

export async function searchFood(req, res) {
  const term = (req.query.q || '').trim();
  if (term.length < MIN_SEARCH_LENGTH) {
    throw new ValidationError(`Search term must be at least ${MIN_SEARCH_LENGTH} characters`);
  }
  res.json({ results: await foodRepository.search(term) });
}
