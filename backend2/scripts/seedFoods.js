/**
 * Imports the Anuvaad INDB food database into the `foods` collection.
 *
 * Reads the slim CSV produced by `ml/src/data/build_food_csv.py`, not the
 * source spreadsheet. Two reasons:
 *
 * 1. The `xlsx` package carries an unpatched HIGH-severity prototype-pollution
 *    and ReDoS advisory with "no fix available" on npm, and it was the only
 *    remaining vulnerability in this service after `npm audit fix`. Reading CSV
 *    removes the dependency rather than accepting the risk.
 * 2. The ML service already generates that CSV for its own cold-start budget,
 *    so both services now read one canonical file.
 *
 * Replaces the original importXLSX.js, which was unrunnable as committed: it
 * pointed at C:/Users/susha/Downloads/... , wrote to database `niyantranaDB`
 * while the server reads `niyantrana`, and threw inside the driver when
 * MONGO_URI was unset.
 *
 * Usage:  npm run seed  [-- path/to/foods.csv]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import mongoose from 'mongoose';

import config from '../src/config/env.js';
import Food from '../src/models/Food.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.resolve(HERE, '../../ml/data/raw/anuvaad_indb_2024.11.csv');

const NUMERIC_FIELDS = ['energy_kj', 'energy_kcal', 'carb_g', 'protein_g', 'fat_g',
  'freesugar_g', 'fibre_g', 'unit_serving_energy_kcal'];

/**
 * Minimal RFC 4180 CSV parser.
 *
 * Hand-rolled rather than adding a dependency: food names contain commas
 * ("Rice, parboiled") and the occasional quote, so a naive split would corrupt
 * rows, but the full grammar is only a few lines.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }  // escaped quote
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell !== ''));
  return body.map((cells) => Object.fromEntries(
    header.map((name, index) => [name.trim(), cells[index]]),
  ));
}

function toDocument(record) {
  const doc = {
    food_code: record.food_code,
    food_name: record.food_name,
    primarysource: record.primarysource,
    servings_unit: record.servings_unit,
  };
  for (const field of NUMERIC_FIELDS) {
    const value = Number(record[field]);
    if (Number.isFinite(value)) doc[field] = value;
  }
  return doc;
}

async function main() {
  const source = process.argv[2] || DEFAULT_CSV;
  if (!fs.existsSync(source)) {
    throw new Error(
      `${source} not found. Generate it with:\n`
      + '  cd ml && python -m src.data.build_food_csv',
    );
  }

  console.log(`Reading ${source}`);
  const records = parseCsv(fs.readFileSync(source, 'utf8'));
  const documents = records
    .map(toDocument)
    .filter((d) => d.food_name && Number.isFinite(d.energy_kcal));
  console.log(`Parsed ${documents.length} usable rows of ${records.length}`);

  await mongoose.connect(config.mongoUri);
  await Food.deleteMany({});
  await Food.insertMany(documents, { ordered: false });
  const total = await Food.estimatedDocumentCount();
  console.log(`Seeded ${total} foods into ${config.mongoUri}`);
  await mongoose.disconnect();
}

// Only run when invoked directly, so the parser can be unit tested.
// pathToFileURL, not string concatenation: on Windows the latter yields
// file://D:/... while import.meta.url is file:///D:/... and never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Seed failed:', error.message);
    process.exit(1);
  });
}
