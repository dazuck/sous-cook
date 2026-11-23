import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../drizzle/schema";

// Lazy initialization to avoid errors during build
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  // Configure connection pool for Supabase
  // - prepare: false - required for Supabase pooler (transaction/session mode)
  // - max: 3 - limit concurrent connections to avoid MaxClientsInSessionMode
  // - idle_timeout: 20 - close idle connections after 20 seconds
  // - connect_timeout: 10 - fail fast on connection issues
  const client = postgres(connectionString, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  _db = drizzle(client, { schema });
  return _db;
}

// Export a proxy that lazily initializes the db
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    return getDb()[prop as keyof typeof _db];
  },
});

// Export schema for easy imports
export * from "../../drizzle/schema";
