import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        ink: {
          900: "#0a0c10",
          800: "#0f1218",
          700: "#161b24",
          600: "#1e2530",
          500: "#2a323f",
        },
        line: "#252b36",
        signal: {
          DEFAULT: "#4ade80", // green = healthy
          dim: "#16331f",
        },
        amber: { DEFAULT: "#fbbf24", dim: "#3a2e0c" },
        rose: { DEFAULT: "#fb7185", dim: "#3a1620" },
        cyan: { DEFAULT: "#38bdf8", dim: "#0c2a3a" },
      },
    },
  },
  plugins: [],
};

export default config;
