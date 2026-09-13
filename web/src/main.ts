import { createApp } from "vue";
import "ant-design-vue/dist/reset.css";

import App from "./App.vue";
import { router } from "./router";
import "./style.css";

const app = createApp(App);
app.use(router);
app.mount("#app");
