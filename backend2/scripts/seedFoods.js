/**
 * Imports the Anuvaad INDB spreadsheet into the foods collection.
 *
 * Replaces importXLSX.js, which was unrunnable as committed:
 * - it pointed at C:/Users/susha/Downloads/... , another machine absolute path;
 * - it wrote to database niyantranaDB while the server reads niyantrana, so
 *   imported food landed somewhere the API never queried;
 * - MONGO_URI had no fallback, so an unset variable threw inside the driver.
 *
 * Usage:  node scripts/seedFoods.js [path-to-xlsx]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';
import XLSX from 'xlsx';

import config from '../src/config/env.js';
import Food from '../src/models/Food.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_XLSX = path.resolve(HERE, '../../ml/data/raw/Anuvaad_INDB_2024.11.xlsx');

const NUMERIC_FIELDS = ['energy_kj', 'energy_kcal', 'carb_g', 'protein_g', 'fat_g',
  'freesugar_g', 'fibre_g', 'unit_serving_energy_kcal'];

function toDocument(row) {
  const doc = {
    food_code: row.food_code,
    food_name: row.food_name,
    primarysource: row.primarysource,
    servings_unit: row.servings_unit,
  };
  for (const field of NUMERIC_FIELDS) {
    const value = Number(row[field]);
    if (Number.isFinite(value)) doc[field] = value;
  }
  return doc;
}

async function main() {
  const source = process.argv[2] || DEFAULT_XLSX;
  console.log(`Reading ${source}`);

  const workbook = XLSX.readFile(source);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

  const documents = rows
    .map(toDocument)
    .filter((d) => d.food_name && Number.isFinite(d.energy_kcal));
  console.log(`Parsed ${documents.length} usable rows of ${rows.length}`);

  await mongoose.connect(config.mongoUri);
  await Food.deleteMany({});
  await Food.insertMany(documents, { ordered: false });
  console.log(`Seeded ${await Food.estimatedDocumentCount()} foods into ${config.mongoUri}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
