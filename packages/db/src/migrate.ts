import { loadDatabaseConfig } from "./config.js";
import { openDatabase } from "./client.js";

const config = loadDatabaseConfig();
const connection = await openDatabase(config);
await connection.client.end();
console.log(`Database is up to date at ${config.dataDir ?? "memory"}.`);
