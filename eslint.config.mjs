import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "fixtures/demo-app/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts"] },
  {
    // Token isolation: only the config module may read process.env (SECURITY_POLICY §1.2).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/config/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "Read configuration only through src/server/config/env.ts.",
        },
      ],
    },
  },
  {
    // Persian RTL: forbid physical-direction Tailwind utilities; use logical ones (ms-/me-/ps-/pe-/start-/end-/text-start).
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "Read configuration only through src/server/config/env.ts.",
        },
        {
          selector: "Literal[value=/(^|[\\s\"'`:])(-?)(ml|mr|pl|pr|left|right)-[\\w\\[]/]",
          message: "Use logical utilities (ms-/me-/ps-/pe-/start-/end-) for RTL.",
        },
        {
          selector: "TemplateElement[value.raw=/(^|[\\s:])(-?)(ml|mr|pl|pr|left|right)-[\\w\\[]/]",
          message: "Use logical utilities (ms-/me-/ps-/pe-/start-/end-) for RTL.",
        },
        {
          selector: "Literal[value=/(^|[\\s\"'`:])text-(left|right)(\\s|$)/]",
          message: "Use text-start / text-end for RTL.",
        },
      ],
    },
  },
  {
    files: ["src/server/config/**"],
    rules: { "no-restricted-syntax": "off" },
  },
];

export default config;
