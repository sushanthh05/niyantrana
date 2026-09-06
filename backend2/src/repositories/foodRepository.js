/**
 * Data access for the Indian food composition database.
 *
 * Refactoring applied: Extract Class. Also fixes a regex-injection vector: the
 * v1 search route interpolated the raw `q` parameter into a `$regex`.
 */
import Food from '../models/Food.js';
import { escapeRegex } from '../domain/text.js';

export class FoodRepository {
  search(term, limit = 10) {
    return Food.find({ food_name: { $regex: escapeRegex(term), $options: 'i' } })
      .limit(limit)
      .lean();
  }

  count() {
    return Food.estimatedDocumentCount();
  }
}

export default new FoodRepository();
