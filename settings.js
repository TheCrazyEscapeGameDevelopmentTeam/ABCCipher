const DEFAULT_SETTINGS = {
  updateMode: "auto",
  theme: "dark",
  accentColor: "#79baff",
  fontSize: "normal",
  animations: true
};

const SETTINGS_KEY = "abc-cipher-settings";

function loadSettings() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SETTINGS_KEY)
    );

    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      return { ...DEFAULT_SETTINGS };
    }

    return {
      updateMode: ["auto", "manual"].includes(saved.updateMode)
        ? saved.updateMode : DEFAULT_SETTINGS.updateMode,

      theme: ["dark", "light", "system"].includes(saved.theme)
        ? saved.theme : DEFAULT_SETTINGS.theme,

      accentColor: /^#[0-9a-fA-F]{6}$/.test(saved.accentColor)
        ? saved.accentColor : DEFAULT_SETTINGS.accentColor,

      fontSize: ["small", "normal", "large"].includes(saved.fontSize)
        ? saved.fontSize : DEFAULT_SETTINGS.fontSize,

      animations: typeof saved.animations === "boolean"
        ? saved.animations : DEFAULT_SETTINGS.animations
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = loadSettings();

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify(settings)
  );
}

function applySettings() {
  const root = document.documentElement;

  let theme = settings.theme;

  if (theme === "system") {
    theme = window.matchMedia(
      "(prefers-color-scheme: light)"
    ).matches ? "light" : "dark";
  }

  root.dataset.theme = theme;
  root.dataset.animations = settings.animations ? "on" : "off";

  root.style.setProperty(
    "--accent-color",
    settings.accentColor
  );

  const fontSizes = {
    small: "14px",
    normal: "16px",
    large: "19px"
  };

  root.style.setProperty(
    "--base-font-size",
    fontSizes[settings.fontSize]
  );
}

function updateSetting(name, value) {
  if (!(name in DEFAULT_SETTINGS)) return;

  settings[name] = value;

  // 値を検証しながら保存する
  settings = {
    ...DEFAULT_SETTINGS,
    ...settings
  };

  saveSettings();
  applySettings();

  // アップデート方式を変更したら、
  // 更新管理側にも変更を知らせる
  window.dispatchEvent(
    new CustomEvent("abc-settings-changed")
  );
}

function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  applySettings();

  window.dispatchEvent(
    new CustomEvent("abc-settings-changed")
  );
}

window.ABCSettings = {
  get: () => ({ ...settings }),
  update: updateSetting,
  reset: resetSettings
};

// システムテーマ変更にも追従
const themeMedia = window.matchMedia(
  "(prefers-color-scheme: light)"
);

themeMedia.addEventListener?.("change", () => {
  if (settings.theme === "system") {
    applySettings();
  }
});

applySettings();
