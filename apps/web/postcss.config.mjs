// Tailwind 4 se integra con Next por PostCSS. El tema sale de `tailwind.config.ts`, que lee `src/design/tokens.ts`.
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
