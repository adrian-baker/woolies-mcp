import js from "@eslint/js";
import tseslint from "typescript-eslint";
import functional from "eslint-plugin-functional";
import prettier from "eslint-config-prettier";

/** The pure core: parsing and mapping. No IO, no mutation, no time. */
const PURE_CORE = ["src/woolworths/schemas.ts", "src/woolworths/mappers.ts"];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "*.config.mjs"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      // tsconfig.check.json is the one covering both src and scripts.
      parserOptions: { project: ["./tsconfig.check.json"], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { functional },
    rules: {
      // Our own declared types are readonly everywhere, core and shell alike.
      "functional/type-declaration-immutability": [
        "error",
        { rules: [{ identifiers: ".+", immutability: "ReadonlyShallow", comparator: "AtLeast" }] },
      ],
      "prefer-const": "error",
      "no-param-reassign": "error",

      // Fail early.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowNullableBoolean: true, allowNullableString: false },
      ],

      // Bracket access on an index signature is deliberate: process.env has no declared keys.
      "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],
      // Numbers and booleans in templates are legible and intended.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // Immutability is enforced hardest where the code is pure.
    files: PURE_CORE,
    rules: {
      "functional/no-let": "error",
      // Off: every hit was a local collection filled and returned by a pure function, which the
      // rule cannot tell apart from mutating shared state.
      "functional/immutable-data": "off",
      "functional/prefer-immutable-types": [
        "error",
        {
          enforcement: "ReadonlyShallow",
          ignoreInferredTypes: true,
          // Boundaries are enforced; local accumulators are not, for the reason above.
          variables: { enforcement: "None" },
        },
      ],
    },
  },
  prettier,
);
