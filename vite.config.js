import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // dev server (npm run dev)
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    https: false,
  },

  // preview server (npm run preview)
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    https: false,
  },
});