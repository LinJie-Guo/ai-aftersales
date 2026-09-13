import { serve } from "@hono/node-server";

import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { seed } from "./db/seed.ts";
import { createApp } from "./http/app.ts";
import { resumeOrphanSessions } from "./http/sessions.ts";
import { rotateLegacySecrets } from "./db/rotate-secrets.ts";
import { backfillFileOwnership } from "./db/backfill-files.ts";
import { backfillKnowledgeSearch } from "./knowledge/docs.ts";

async function main() {
  await migrate();
  await rotateLegacySecrets();
  await seed();
  await backfillFileOwnership();
  await backfillKnowledgeSearch();
  const app = createApp();
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`${config.appName} listening on ${info.port}`);
    void resumeOrphanSessions();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
