import { MongoClient } from 'mongodb';
import xlsx from 'xlsx';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'niyantranaDB'; // The name of your database
const COLLECTION_NAME = 'foods'; // The name of the collection for food items
const XLSX_FILE_PATH = 'C:/Users/susha/Downloads/Anuvaad_INDB_2024.11_updated.xlsx'; // IMPORTANT: Your file path

const importData = async () => {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('MongoDB connected for import...');

    const database = client.db(DB_NAME);
    const collection = database.collection(COLLECTION_NAME);

    // Clear existing data from the collection
    await collection.deleteMany({});
    console.log('Cleared existing food data.');

    // Read the Excel file from your computer
    const workbook = xlsx.readFile(XLSX_FILE_PATH);
    const sheetName = workbook.SheetNames[0]; // Assumes your data is on the first sheet
    const sheet = workbook.Sheets[sheetName];

    // Convert the sheet's data to a JSON array
    const data = xlsx.utils.sheet_to_json(sheet);
    
    if (data.length === 0) {
      console.log('No data found in the Excel sheet.');
      return;
    }
    
    // Insert the JSON data into the MongoDB collection
    await collection.insertMany(data);
    console.log(`Success! ${data.length} food items have been imported from the XLSX file.`);

  } catch (error) {
    console.error('Error during data import:', error);
  } finally {
    // Ensure the database connection is closed
    await client.close();
    console.log('MongoDB connection closed.');
  }
};

importData();