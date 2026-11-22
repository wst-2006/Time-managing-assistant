import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.wst2006.timemanagingassistant",
  appName: "时间管理助手",
  webDir: "www",
  android: {
    allowMixedContent: false,
    // lets chrome://inspect on a computer show the app's console when a phone misbehaves
    webContentsDebuggingEnabled: true,
    // Android 15 draws apps under the status bar; keep the app below it.
    adjustMarginsForEdgeToEdge: "force"
  },
  backgroundColor: "#ff1446",
  plugins: {
    LocalNotifications: { iconColor: "#FF1446" }
  }
};

export default config;
