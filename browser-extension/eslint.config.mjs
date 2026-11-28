// Deliberately untyped browser runtime code; no Node globals are granted to shipped scripts.
export default [
  { ignores: ["dist/**"] },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        globalThis: "readonly",
        document: "readonly",
        navigator: "readonly",
        crypto: "readonly",
        HTMLMediaElement: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextEncoder: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      eqeqeq: "error",
    },
  },
];
