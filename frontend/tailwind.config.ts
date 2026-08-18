import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        abyss: "#060D1A",
        ocean: "#0B1829",
        raised: "#0F2238",
        border: { DEFAULT: "#1A3350" },
        accent: "#0EA5E9",
        ink: {
          primary: "#F8FAFC",
          secondary: "#8BAFC8",
        },
        success: "#10B981",
        danger: "#EF4444",
        warning: "#F59E0B",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      keyframes: {
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(16,185,129,0.45)" },
          "70%": { boxShadow: "0 0 0 6px rgba(16,185,129,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(16,185,129,0)" },
        },
        "pulse-ring-accent": {
          "0%": { boxShadow: "0 0 0 0 rgba(14,165,233,0.45)" },
          "70%": { boxShadow: "0 0 0 6px rgba(14,165,233,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(14,165,233,0)" },
        },
        blink: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.25" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "skeleton": {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 2s cubic-bezier(0.4,0,0.6,1) infinite",
        "pulse-ring-accent": "pulse-ring-accent 2s cubic-bezier(0.4,0,0.6,1) infinite",
        blink: "blink 1.2s step-start infinite",
        "fade-up": "fade-up 0.15s ease-out",
        skeleton: "skeleton 1.4s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
