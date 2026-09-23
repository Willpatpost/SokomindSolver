import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // Flat config does not read .gitignore, so scratch and report output is
    // listed here too.
    ignores: [
      "dist/**",
      "coverage/**",
      "tmp/**",
      "test-results/**",
      "playwright-report/**",
      "review-catalog/**",
      "results/**",
      "src/solver/implementations/sokomind-engine/engine.generated.js",
      "src/solver/implementations/sokomind-engine/source/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
    },
  },
  {
    files: ["eslint.config.mjs", "scripts/**/*.{js,mjs}", "tests/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
);
