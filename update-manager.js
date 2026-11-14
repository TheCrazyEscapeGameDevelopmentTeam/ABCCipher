(async () => {
  if (!("serviceWorker" in navigator)) return;
  if (!window.ABCSettings) return;

  // このページがすでにService Workerに
  // 制御されているかを記録
  const hadController = !!navigator.serviceWorker.controller;

  let registration;
  let reloading = false;
  let notifiedWorker = null;

  // 更新適用後に新しいアプリを読み込む
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => {
      if (hadController && !reloading) {
        reloading = true;
        location.reload();
      }
    }
  );

  function getUpdateMode() {
    return ABCSettings.get().updateMode;
  }

  function activateUpdate(worker) {
    if (!worker) return;

    worker.postMessage({
      type: "ACTIVATE_UPDATE"
    });
  }

  function notifyManualUpdate(worker) {
    if (!worker || notifiedWorker === worker) return;

    if (getUpdateMode() !== "manual") return;

    notifiedWorker = worker;

    const accepted = confirm(
      "ABC Cipherの新しいバージョンがあります。\n\n" +
      "今すぐ更新しますか？"
    );

    if (accepted) {
      activateUpdate(worker);
    }
  }

  function handleWaitingWorker(isStartup) {
    const worker = registration.waiting;
    if (!worker) return;

    const mode = getUpdateMode();

    if (mode === "auto") {
      // 起動時から待機していた更新だけを適用
      if (isStartup) {
        activateUpdate(worker);
      }
    } else {
      notifyManualUpdate(worker);
    }
  }

  function watchInstallingWorker(worker) {
    if (!worker) return;

    worker.addEventListener("statechange", () => {
      if (worker.state !== "installed") return;

      // 初回インストールでは通知しない
      if (!hadController) return;

      // 今回の起動中に見つかった更新は待機させる
      handleWaitingWorker(false);
    });
  }

  try {
    registration = await navigator.serviceWorker.register(
      "./service-worker.js",
      { updateViaCache: "none" }
    );

    // 起動時点ですでに待機中の更新があるか確認
    if (registration.waiting && hadController) {
      handleWaitingWorker(true);
    }

    // 起動時にサーバーへ更新を確認
    await registration.update();

    // 新しいService Workerが見つかったとき
    registration.addEventListener("updatefound", () => {
      watchInstallingWorker(registration.installing);
    });

    // 登録時点ですでにインストール中の場合
    if (registration.installing) {
      watchInstallingWorker(registration.installing);
    }

    // 設定変更時の処理
    window.addEventListener("abc-settings-changed", () => {
      // 手動モードに切り替えたとき、
      // すでに待機中の更新があれば通知する
      if (getUpdateMode() === "manual") {
        handleWaitingWorker(false);
      }

      // 自動モードに変えても、
      // 現在の起動中には更新しない
    });

    // アプリに戻ってきたときにも更新確認
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        navigator.onLine
      ) {
        registration.update().catch(error => {
          console.log("更新確認に失敗:", error);
        });
      }
    });

  } catch (error) {
    console.error("Service Workerの更新管理に失敗:", error);
  }
})();
