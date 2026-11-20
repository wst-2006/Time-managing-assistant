import { defineConfig } from "drizzle-kit";

// Migrations are generated from the schema only; no database connection is needed.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  verbose: true,
  strict: true
});
