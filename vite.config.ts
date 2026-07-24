import { defineConfig } from "vite";

// The Vite dev server serves the frontend; the terminal backend runs
// separately (npm run dev:server) on PORT 3000. We proxy the WebSocket
// endpoint so the browser can connect to ws://localhost:5173/pty in dev.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/pty": {
        target: "ws://localhost:3000",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3000",
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
