import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const engineDirectory = "src/solver/implementations/sokomind-engine";
const engineBundle = `${engineDirectory}/engine.generated.js`;

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
    ignores: [engineBundle],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
    },
  },
  {
    // The engine sources are classic scripts that share one lexical scope, so
    // a name declared in one file and used in another is only checked on the
    // bundle that concatenates them.
    files: [`${engineDirectory}/source/**/*.js`],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.worker, module: "readonly" },
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // The bundle is generated from the sources above, so only the rules that
    // need the shared scope run on it. It is a module, so a name declared in
    // two source files is already a parse error.
    files: [engineBundle],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.worker,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", {
        // Each source module builds a namespace object that the prepare
        // script's registration strip leaves unused.
        varsIgnorePattern: "^(?:Sokomind[A-Z]|_)",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
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
