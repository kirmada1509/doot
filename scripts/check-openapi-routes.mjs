import { readFileSync } from "node:fs";

const serverSource = readFileSync("apps/control-api/src/server.ts", "utf8");
const openApiSource = readFileSync("packages/contracts/openapi/doot.v1.yaml", "utf8");

const serverRoutes = [...serverSource.matchAll(/\.(?:get|post)\(\s*"([^"]+)"/g)]
  .map((match) => match[1].replace(/:([A-Za-z0-9_]+)/g, "{$1}"))
  .sort();

const documentedRoutes = [...openApiSource.matchAll(/^  (\/[^\s:]+):$/gm)].map((match) => match[1]).sort();

const missing = serverRoutes.filter((route) => !documentedRoutes.includes(route));
const stale = documentedRoutes.filter((route) => !serverRoutes.includes(route));

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) console.error(`Missing OpenAPI routes:\n${missing.map((route) => `  ${route}`).join("\n")}`);
  if (stale.length > 0) console.error(`Stale OpenAPI routes:\n${stale.map((route) => `  ${route}`).join("\n")}`);
  process.exit(1);
}

console.log(`OpenAPI route coverage ok (${serverRoutes.length} routes).`);
