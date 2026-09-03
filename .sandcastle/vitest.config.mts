import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The harness is not part of the application. The root config deliberately
 * scopes `npm test` — one of the gates every agent must clear — to `src/`, so
 * the orchestrator's own tests get their own run: `npm run sandcastle:test`.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.mts"],
  },
});
