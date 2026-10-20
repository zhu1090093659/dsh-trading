import type { Config } from "tailwindcss";
import path from 'node:path';

export default {
  darkMode: "class",
  content: [path.join(__dirname, "mount.tsx"), path.join(__dirname, "src/**/*.{ts,tsx}")],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        success: "hsl(var(--success))",
        danger: "hsl(var(--danger))",
        warning: "hsl(var(--warning))",
        info: "hsl(var(--info))",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        mono: ["SFMono-Regular", "JetBrains Mono", "Consolas", "ui-monospace", "monospace"],
      },
      borderRadius: { "3xl": "14px", "2xl": "10px", xl: "8px", lg: "var(--radius)", md: "6px", sm: "4px" },
      boxShadow: {
        glass: "none",
        glow: "0 0 0 1px hsl(var(--primary) / .3)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
