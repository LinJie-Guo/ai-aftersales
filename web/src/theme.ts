import { computed, ref, watch } from "vue";
import { theme } from "ant-design-vue";

const KEY = "aftersale-theme";
const presets = ["#1677ff", "#13c2c2", "#52c41a", "#722ed1", "#fa8c16", "#eb2f96", "#2f54eb", "#171717"];

const light = {
  colorBgLayout: "#f6f6f8",
  colorBgContainer: "#ffffff",
  colorText: "#222326",
  colorTextSecondary: "#6b6f76",
  colorBorder: "#e6e7eb",
};

const dark = {
  colorBgLayout: "#111318",
  colorBgContainer: "#1a1c22",
  colorText: "#eceef2",
  colorTextSecondary: "#9aa1ad",
  colorBorder: "#2e323c",
};

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}

const stored = read();
const isDark = ref(stored?.dark === true);
const primary = ref(stored?.primary || "#1677ff");

function applyDocumentTheme() {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark.value);
  root.style.colorScheme = isDark.value ? "dark" : "light";
  localStorage.setItem(KEY, JSON.stringify({ dark: isDark.value, primary: primary.value }));
}

watch([isDark, primary], applyDocumentTheme, { immediate: true });

export function useTheme() {
  const { darkAlgorithm, defaultAlgorithm } = theme;
  const themeConfig = computed(() => {
    const palette = isDark.value ? dark : light;
    return {
      algorithm: isDark.value ? darkAlgorithm : defaultAlgorithm,
      token: {
        colorPrimary: primary.value,
        borderRadius: 6,
        colorBgLayout: palette.colorBgLayout,
        colorBgContainer: palette.colorBgContainer,
        colorBgElevated: palette.colorBgContainer,
        colorText: palette.colorText,
        colorTextSecondary: palette.colorTextSecondary,
        colorBorder: palette.colorBorder,
        colorBorderSecondary: palette.colorBorder,
      },
    };
  });
  return { isDark, primary, presets, themeConfig };
}
