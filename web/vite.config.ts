import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the site from /<repo-name>/. Override with BASE_PATH when
// deploying elsewhere (e.g. BASE_PATH=/ for a custom domain or local preview).
const base = process.env.BASE_PATH ?? "/job-app-tracker/";

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173 },
});
