"use strict";

(async () => {
  if (!("serviceWorker" in navigator)) return;
  if (!window.ABCSettings) return;

  const hadController = !!navigator.serviceWorker.controller;

  let registration;
  let reloading = false;
  let notifiedWorker = null;

  // --------------------------------------
  // 通信方式の判定
  // --------------------------------------

  function isCellular() {
    const connection =
      navigator.connection ||
      navigator.mozConnection ||
      navigator.webkitConnection;

    return connection?.type === "cellular";
  }

  // --------------------------------------
  // 更新設定
  // --------------------------------------

  function getUpdateMode() {
    return ABCSettings.get().updateMode;
  }

  // --------------------------------------
  // 更新を適用
  // --------------------------------------

  function activateUpdate(worker) {
    if (!worker) return;

    worker.postMessage({
      type: "ACTIVATE_UPDATE"
    });
  }

  // --------------------------------------
  // 手動更新通知
  // --------------------------------------

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

  // --------------------------------------
  // 待機中の更新を確認
  // --------------------------------------

  function handleWaitingWorker(isStartup) {
    const worker = registration.waiting;

    if (!worker) return;

    if (getUpdateMode() === "auto") {
      // 自動更新は次回起動時だけ適用
      if (isStartup) {
        activateUpdate(worker);
      }
    } else {
      notifyManualUpdate(worker);
    }
  }

  // --------------------------------------
  // インストール中のWorkerを監視
  // --------------------------------------

  function watchInstallingWorker(worker) {
    if (!worker) return;

    worker.addEventListener("statechange", () => {
      if (worker.state !== "installed") return;

      // 初回インストールでは通知しない
      if (!hadController) return;

      // 使用中に発見した更新は待機
      handleWaitingWorker(false);
    });
  }

  // --------------------------------------
  // 新しいWorkerの発見
  // --------------------------------------

  try {
    // 既存の登録を先に確認
    registration =
      await navigator.serviceWorker.getRegistration();

    // 初回だけ登録
    if (!registration) {
      registration =
        await navigator.serviceWorker.register(
          "./service-worker.js",
          { updateViaCache: "none" }
        );
    }

    // 更新発見イベントを先に登録
    registration.addEventListener("updatefound", () => {
      watchInstallingWorker(registration.installing);
    });

    // すでにインストール中なら監視
    if (registration.installing) {
      watchInstallingWorker(registration.installing);
    }

    // 起動時点で待機中の更新があるか確認
    if (registration.waiting && hadController) {
      handleWaitingWorker(true);
    }

    // ----------------------------------
    // 更新確認
    // ----------------------------------

    // モバイルデータ通信と判定できた場合は、
    // 明示的な更新確認を控える
    if (!isCellular()) {
      await registration.update();
    }

    // ----------------------------------
    // 設定変更
    // ----------------------------------

    window.addEventListener(
      "abc-settings-changed",
      () => {
        if (getUpdateMode() === "manual") {
          handleWaitingWorker(false);
        }

        // autoに変更しても、使用中は適用しない
      }
    );

    // ----------------------------------
    // アプリに戻ったとき
    // ----------------------------------

    document.addEventListener(
      "visibilitychange",
      () => {
        if (
          document.visibilityState === "visible" &&
          !isCellular()
        ) {
          registration.update().catch(error => {
            console.log("更新確認に失敗:", error);
          });
        }
      }
    );

    // ----------------------------------
    // 更新適用後にページを再読み込み
    // ----------------------------------

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        if (hadController && !reloading) {
          reloading = true;
          location.reload();
        }
      }
    );

  } catch (error) {
    console.error(
      "Service Workerの更新管理に失敗:",
      error
    );
  }
})();
