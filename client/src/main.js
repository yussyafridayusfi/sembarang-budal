import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import "leaflet/dist/leaflet.css";

createApp(App).mount("#app");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}
