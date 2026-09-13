import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "../config.ts";
import * as schema from "./schema.ts";

const url = config.databaseUrl.replace(/^postgresql\+psycopg:\/\//, "postgres://");
export const sql = postgres(url, { max: 10 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
