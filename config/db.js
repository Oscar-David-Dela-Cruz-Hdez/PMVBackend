import { MongoClient } from 'mongodb';

let client;
let database;

export async function connectToMongoDB() {
  if (database) return database;

  const connectionString = process.env.MONGODB_URI || process.env.MONGO_URI;
  const databaseName = process.env.MONGODB_DB_NAME || 'reparaya_pmv';

  if (!connectionString) {
    throw new Error('Falta MONGODB_URI o MONGO_URI. Configura la cadena de Atlas en .env.');
  }

  client = new MongoClient(connectionString);
  await client.connect();
  database = client.db(databaseName);
  return database;
}

export async function disconnectFromMongoDB() {
  if (client) {
    await client.close();
    client = undefined;
    database = undefined;
  }
}
