const DEFAULT_SETTINGS = {
  updateMode: "auto",
  theme: "dark",
  accentColor: "#79baff",
  fontSize: "normal",
  animations: true
};

function loadSettings() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("abc-cipher-settings")
    );

    return {
      ...DEFAULT_SETTINGS,
      ...(saved && typeof saved === "object" ? saved : {})
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = loadSettings();

function saveSettings() {
  localStorage.setItem(
    "abc-cipher-settings",
    JSON.stringify(settings)
  );
}

function applySettings() {
  const root = document.documentElement;

  // テーマ
  let theme = settings.theme;

  if (theme === "system") {
    theme = window.matchMedia(
      "(prefers-color-scheme: light)"
    ).matches ? "light" : "dark";
  }

  root.dataset.theme = theme;

  // アクセントカラー
  root.style.setProperty(
    "--accent-color",
    settings.accentColor
  );

  // 文字サイズ
  const sizes = {
    small: "14px",
    normal: "16px",
    large: "19px"
  };

  root.style.setProperty(
    "--base-font-size",
    sizes[settings.fontSize] || sizes.normal
  );

  // アニメーション
  root.dataset.animations =
    settings.animations ? "on" : "off";
}

function updateSetting(name, value) {
  settings[name] = value;
  saveSettings();
  applySettings();
}

// 他のJavaScriptから利用できるようにする
window.ABCSettings = {
  get: () => ({ ...settings }),
  update: updateSetting,
  reset: () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applySettings();
  }
};

applySettings();
