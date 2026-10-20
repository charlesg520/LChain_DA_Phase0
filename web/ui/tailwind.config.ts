import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        panel: v("panel"),
        "panel-hi": v("panel-hi"),
        border: v("border"),
        text: v("text"),
        muted: v("muted"),
        accent: v("accent"),
        ok: v("ok"),
        warn: v("warn"),
        err: v("err"),
        info: v("info"),
      },
      borderRadius: { panel: "10px", card: "8px" },
      fontFamily: {
        sans: ["Inter", "Inter Variable", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "JetBrainsMono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      keyframes: {
        pulsedot: { "0%,100%": { opacity: "1", transform: "scale(1)" }, "50%": { opacity: ".45", transform: "scale(.85)" } },
        ring: { "0%": { boxShadow: "0 0 0 0 rgb(var(--ring) / .55)" }, "100%": { boxShadow: "0 0 0 7px rgb(var(--ring) / 0)" } },
        blink: { "0%,49%": { opacity: "1" }, "50%,100%": { opacity: "0" } },
        slidein: { from: { transform: "translateY(8px)", opacity: "0" }, to: { transform: "translateY(0)", opacity: "1" } },
        flash: { "0%": { backgroundColor: "rgb(var(--ok) / .25)" }, "100%": { backgroundColor: "transparent" } },
      },
      animation: {
        pulsedot: "pulsedot 1.4s ease-in-out infinite",
        ring: "ring 1.4s ease-out infinite",
        blink: "blink 1s steps(1) infinite",
        slidein: "slidein .18s ease-out",
        flash: "flash .9s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
