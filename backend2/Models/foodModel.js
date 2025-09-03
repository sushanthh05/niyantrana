import mongoose from 'mongoose';

const foodSchema = new mongoose.Schema({
  food_code: String,
  food_name: {
    type: String,
    required: true,
    index: true // Add index for better search performance
  },
  primarysource: String,
  energy_kj: Number,
  energy_kcal: {
    type: Number,
    required: true
  },
  carb_g: Number,
  protein_g: Number,
  fat_g: Number,
  freesugar_g: Number,
  fibre_g: Number,
  // Add other nutritional fields as needed
  servings_unit: String,
  unit_serving_energy_kcal: Number
}, {
  timestamps: true
});

// Create a text index for better search functionality
foodSchema.index({ food_name: 'text' });

const Food = mongoose.model('Food', foodSchema);

export default Food;
