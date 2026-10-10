import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  { files: ["src/**/*.tsx"], ...reactHooks.configs.flat.recommended },
  globalIgnores([".next/**", ".data/**", "work/**", "next-env.d.ts"]),
]);
