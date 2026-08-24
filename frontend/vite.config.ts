import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("@supabase/supabase-js")) {
            return "supabase";
          }

          if (
            id.includes("react-router-dom") ||
            id.includes("react-dom") ||
            id.includes("\\react\\") ||
            id.includes("/react/")
          ) {
            return "react";
          }

          if (id.includes("axios")) {
            return "vendor";
          }

          return undefined;
        },
      },
    },
  },
});
