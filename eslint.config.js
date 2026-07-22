import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["hooks/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { process: "readonly", fetch: "readonly" },
    },
  },
];
