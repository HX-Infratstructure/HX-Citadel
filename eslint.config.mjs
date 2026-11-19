import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import convexPlugin from "@convex-dev/eslint-plugin";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...convexPlugin.configs.recommended,
  // AGENTS.md "Code standards", rule 5 "Keep code flat".
  { rules: { "no-nested-ternary": "error" } },
  // AGENTS.md "Code standards", rule 8. These numbers live only here; existing violations are in eslint-suppressions.json.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.fixture.ts", "components/ui/**", "**/*.d.ts"],
    rules: {
      complexity: ["error", 10],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 4],
      "max-lines": ["error", { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "convex/_generated/**",
    // Claude Code harness state (nested worktrees of parallel tracks).
    ".claude/**",
  ]),
]);

export default eslintConfig;
