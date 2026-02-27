import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: si tu déploies sur GitHub Pages, remplace "/UBS/" par "/<NOM_DU_REPO>/"
export default defineConfig({
  base: "/UBS/",
  plugins: [react()],
});
