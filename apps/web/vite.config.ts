import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const mobileSource = fileURLToPath(new URL("../mobile/src", import.meta.url));

export default defineConfig(({ mode }) => {
  const mobile = mode === "mobile";
  return {
    plugins: [react()],
    // Relative asset paths so the phone app can load the bundle from its own files.
    base: mobile ? "./" : "/",
    define: mobile ? {
      "import.meta.env.VITE_TMA_TARGET": JSON.stringify("mobile"),
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify("http://tma.local")
    } : {},
    resolve: {
      alias: [
        // Desktop builds get an empty stand-in so the phone backend is never bundled.
        ...(mobile ? [] : [{ find: "@tma-mobile/backend", replacement: fileURLToPath(new URL("./src/mobile-backend-stub.ts", import.meta.url)) }]),
        { find: "@tma-mobile", replacement: mobileSource },
        // The shared API code imports node:crypto; the phone build gets a web version.
        ...(mobile ? [{ find: /^node:crypto$/, replacement: `${mobileSource}/node-crypto-shim.ts` }] : [])
      ]
    },
    optimizeDeps: { exclude: ["@electric-sql/pglite"] },
    build: mobile ? { target: "es2022", chunkSizeWarningLimit: 4000 } : {},
    server: {
      host: "127.0.0.1",
      port: 5173
    }
  };
});
