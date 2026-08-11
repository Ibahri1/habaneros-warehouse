import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});