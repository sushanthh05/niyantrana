/** Indian food composition entry (Anuvaad INDB 2024.11). */
import mongoose from 'mongoose';

const foodSchema = new mongoose.Schema({
  food_code: { type: String, index: true },
  food_name: { type: String, required: true, index: true },
  primarysource: String,
  energy_kj: Number,
  energy_kcal: { type: Number, required: true },
  carb_g: Number,
  protein_g: Number,
  fat_g: Number,
  freesugar_g: Number,
  fibre_g: Number,
  servings_unit: String,
  unit_serving_energy_kcal: Number,
}, { timestamps: true, collection: 'foods' });

foodSchema.index({ food_name: 'text' });

export default mongoose.models.Food || mongoose.model('Food', foodSchema);
