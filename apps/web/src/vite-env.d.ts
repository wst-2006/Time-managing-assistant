/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_TMA_TARGET?: "desktop" | "mobile";
}

declare module "@tma-mobile/backend" {
  export function startLocalBackend(apiBase: string, onStage?: (stage: string) => void): Promise<void>;
}
