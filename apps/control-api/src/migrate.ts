import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@doot/config";

const config = loadConfig();
const sql = postgres(config.DATABASE_URL, { max: 1 });
const migrationsDirectory = fileURLToPath(new URL("../../../infra/migrations/", import.meta.url));

try {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name));
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();

  for (const name of files) {
    if (applied.has(name)) continue;
    const source = await readFile(`${migrationsDirectory}/${name}`, "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`insert into schema_migrations (name) values (${name})`;
    });
    console.log(`Applied ${name}`);
  }
} finally {
  await sql.end();
}
