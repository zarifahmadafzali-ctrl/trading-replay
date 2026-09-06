import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forward API + health calls to the FastAPI backend during `npm run dev`.
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
});
