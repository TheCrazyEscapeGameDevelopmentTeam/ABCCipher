"use strict";

// ==========================================
// 基本設定
// ==========================================

const MAGIC = new Uint8Array([65, 66, 67, 68]); // ABCD
const VERSION = 1;
const CHUNKED_VERSION = 2;
const CHUNK_SIZE = 1024 * 1024;
const CHUNK_HEADER_LENGTH = 69;
const MAX_NAME_BYTES = 4096;
const MAX_TYPE_BYTES = 1024;
const MAX_METADATA_BYTES = 8192;
const MAX_CHUNKS = 0xfffffffe;

let busy = false;
let activeController = null;
let activeSink = null;

function setStatus(message) {
  alert(message);
}

function setBusy(value) {
  busy = value;

  for (const id of [
    "encryptFileButton",
    "decryptFileButton",
    "fileInput",
    "key"
  ]) {
    document.getElementById(id).disabled = value;
  }

  document.getElementById("cancelFileButton").disabled = !value;
}

function cancelFileOperation() {
  if (activeController && !activeController.signal.aborted) {
    activeController.abort();
    setStatus("キャンセルしています。現在のチャンク処理が終わり次第、途中データを破棄します。");
  }
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle ||
      !globalThis.crypto?.getRandomValues) {
    throw new Error(
      "Web Crypto APIが利用できません。HTTPSまたはlocalhostで開いてください。"
    );
  }
}

function concatBytes(...arrays) {
  const length = arrays.reduce((n, a) => n + a.length, 0);
  const result = new Uint8Array(length);

  let offset = 0;

  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }

  return result;
}

// ==========================================
// 鍵の形式
// ==========================================

function toBase64URL(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64URL(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("鍵の形式が正しくありません。");
  }

  const base64 = text
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const binary = atob(
    base64 + "=".repeat((4 - base64.length % 4) % 4)
  );

  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function generateKey() {
  try {
    requireCrypto();

    const bytes = crypto.getRandomValues(new Uint8Array(32));

    document.getElementById("key").value = toBase64URL(bytes);

    setStatus("新しい鍵を生成しました。安全な場所に保存してください。");
  } catch (error) {
    setStatus("鍵生成エラー：" + error.message);
  }
}

async function getCryptoKey() {
  requireCrypto();

  const bytes = getMasterKeyBytes();

  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

function getMasterKeyBytes() {
  const text = document.getElementById("key").value.trim();
  const bytes = fromBase64URL(text);

  if (bytes.length !== 32) {
    throw new Error("鍵は32バイト（256ビット）必要です。");
  }

  return bytes;
}

function saveKey() {
  try {
    const key = document.getElementById("key").value.trim();
    const bytes = fromBase64URL(key);

    if (bytes.length !== 32) {
      throw new Error("有効な鍵を入力してください。");
    }

    const content =
      "ABC Cipher Key File\n" +
      "Version: 2\n" +
      "Key: " + key + "\n";

    downloadBlob(
      new Blob([content], { type: "text/plain;charset=utf-8" }),
      "secret.abckey"
    );

    setStatus("鍵ファイルを保存しました。");
  } catch (error) {
    setStatus("鍵保存エラー：" + error.message);
  }
}

async function loadKey() {
  try {
    const file = document.getElementById("keyFile").files[0];

    if (!file) throw new Error("鍵ファイルを選択してください。");
    if (file.size > 1024) throw new Error("ファイルサイズが不正です。");

    const content = await file.text();

    const match = content.match(
      /^ABC Cipher Key File\r?\nVersion: 2\r?\nKey: ([A-Za-z0-9_-]+)\r?\n?$/
    );

    if (!match) throw new Error("対応していない鍵ファイルです。");

    const bytes = fromBase64URL(match[1]);

    if (bytes.length !== 32) {
      throw new Error("鍵の長さが正しくありません。");
    }

    document.getElementById("key").value = match[1];

    setStatus("鍵を読み込みました。");
  } catch (error) {
    setStatus("鍵読み込みエラー：" + error.message);
  }
}

// ==========================================
// ABC変換
// 1バイトを固定6文字で表現する
// ==========================================

function bytesToABC(bytes) {
  let result = "";

  for (const byte of bytes) {
    let n = byte;
    let code = "";

    for (let i = 0; i < 6; i++) {
      code = ["a", "b", "c"][n % 3] + code;
      n = Math.floor(n / 3);
    }

    result += code;
  }

  return result;
}

function abcToBytes(text) {
  if (!/^[abc]+$/.test(text)) {
    throw new Error("暗号文にはa・b・cのみ使用できます。");
  }

  if (text.length === 0 || text.length % 6 !== 0) {
    throw new Error("暗号文の長さが正しくありません。");
  }

  const bytes = new Uint8Array(text.length / 6);

  for (let i = 0; i < bytes.length; i++) {
    const part = text.slice(i * 6, i * 6 + 6);
    let n = 0;

    for (const char of part) {
      n = n * 3 + { a: 0, b: 1, c: 2 }[char];
    }

    if (n > 255) {
      throw new Error("不正なABCデータです。");
    }

    bytes[i] = n;
  }

  return bytes;
}

// ==========================================
// AES-GCM共通処理
// ==========================================

async function encryptBytes(key, bytes, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128,
        additionalData
      },
      key,
      bytes
    )
  );

  return { iv, encrypted };
}

async function decryptBytes(key, iv, encrypted, additionalData) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128,
        additionalData
      },
      key,
      encrypted
    )
  );
}

// ==========================================
// テキスト暗号化
// ==========================================

async function encryptText() {
  try {
    const text = document.getElementById("plain").value;

    if (!text) throw new Error("文章を入力してください。");

    const key = await getCryptoKey();
    const data = new TextEncoder().encode(text);

    // テキスト用の認証付き暗号化
    const { iv, encrypted } = await encryptBytes(key, data, MAGIC);

    const packet = concatBytes(
    MAGIC,
    new Uint8Array([VERSION]),
    iv,
    encrypted
    );

    document.getElementById("encrypted").textContent =
      bytesToABC(packet);

    setStatus("テキストを暗号化しました。");
  } catch (error) {
    setStatus("暗号化エラー：" + error.message);
  }
}


async function decryptText() {
  try {
    const text = document.getElementById("cipher").value.trim();

    if (!text) {
      throw new Error("ABC暗号文を入力してください。");
    }

    const packet = abcToBytes(text);

    if (packet.length < 32) {
      throw new Error("暗号文が短すぎます。");
    }

    const key = await getCryptoKey();

    let iv;
    let encrypted;
    let decrypted;

    // 旧バージョン v2：ABC2
    if (
      packet[0] === 65 &&
      packet[1] === 66 &&
      packet[2] === 67 &&
      packet[3] === 50
    ) {
      iv = packet.slice(4, 16);
      encrypted = packet.slice(16);

      // 旧版にはadditionalDataがない
      decrypted = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            tagLength: 128
          },
          key,
          encrypted
        )
      );

      setStatus("旧バージョン v2 の暗号文を復号しました。");
    }

    // 現行バージョン：ABCD
    else {
      checkMagic(packet);

      iv = packet.slice(5, 17);
      encrypted = packet.slice(17);

      decrypted = await decryptBytes(
        key,
        iv,
        encrypted,
        MAGIC
      );

      setStatus("現行形式の暗号文を復号しました。");
    }

    const result = new TextDecoder("utf-8", {
      fatal: true
    }).decode(decrypted);

    document.getElementById("decrypted").textContent = result;

  } catch (error) {
    document.getElementById("decrypted").textContent = "";

    let message;

    if (error.name === "OperationError") {
      message = "鍵が一致しないか、暗号文が破損しています。";
    } else if (error.name === "Error") {
      message = error.message;
    } else {
      message = "予期しないエラーが発生しました。";
    }

    setStatus(
      "復号失敗：" + error.name + "：" + message
    );

    console.error("ABC Cipher 復号エラー:", error);
  }
}


// ==========================================
// ABCD v2 チャンクファイル形式
//
// 固定ヘッダー（69 bytes, big-endian）:
//   magic[4], version[1], chunkSize[u32], plainSize[u64],
//   chunkCount[u64], HKDF salt[32], noncePrefix[8],
//   encryptedMetadataLength[u32]
// その後に暗号化メタデータと暗号化チャンクを順に置く。
// メタデータと各チャンクのAADにヘッダー全体、用途識別子、番号、総数、長さを含める。
// HKDF-SHA-256でファイルごとのAES-256-GCM鍵を導出し、IVはnoncePrefix[8] + counter[u32]。
// counter 0はメタデータ、チャンクiはi+1。saltは暗号化ごとに256-bit乱数。

function writeUint32(number) {
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    throw new Error("数値が形式の上限を超えています。");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, number, false);
  return bytes;
}

function writeUint64(number) {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("ファイルサイズが対応範囲を超えています。");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(number), false);
  return bytes;
}

function readUint32(bytes, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > bytes.length) {
    throw new Error("ファイル形式が不正です。");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, false);
}

function checkMagic(packet) {
  if (packet.length < 5 ||
      packet[0] !== MAGIC[0] || packet[1] !== MAGIC[1] ||
      packet[2] !== MAGIC[2] || packet[3] !== MAGIC[3]) {
    throw new Error("ABC Cipher形式ではありません。");
  }
  if (packet[4] !== VERSION) {
    throw new Error("未対応のファイルバージョンです。");
  }
}

function safeFilename(name) {
  name = name.replace(/\\/g, "/").split("/").pop();
  name = name.replace(/[\u0000-\u001f\u007f]/g, "_");
  if (!name || name === "." || name === "..") return "decrypted_file";
  return name.slice(0, 240);
}

function safeMimeType(type) {
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type)
    ? type
    : "application/octet-stream";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function updateFileProgress(label, doneBytes, totalBytes, doneChunks, totalChunks, options) {
  const progress = document.getElementById("fileProgress");
  const detail = document.getElementById("fileProgressDetail");
  const heading = document.getElementById("fileProgressLabel");
  const settings = options || {};
  heading.textContent = label;

  if (settings.indeterminate) {
    progress.removeAttribute("value");
    detail.textContent = settings.detail ||
      ("チャンク " + doneChunks.toLocaleString() + " / " +
       totalChunks.toLocaleString() + " · 暗号処理中");
    return;
  }

  const total = Math.max(0, totalBytes);
  const done = Math.min(Math.max(0, doneBytes), total);
  const ratio = settings.complete ? 1 : (total === 0 ? 0 : done / total);
  const percent = settings.finalizing
    ? Math.min(99, Math.floor(ratio * 100))
    : Math.floor(ratio * 100);
  progress.value = percent;
  detail.textContent =
    done.toLocaleString() + " / " + total.toLocaleString() +
    " bytes · チャンク " + doneChunks.toLocaleString() + " / " +
    totalChunks.toLocaleString() + " · " +
    (settings.finalizing ? "保存確定中" : percent + "%");
}

function assertNotCancelled(signal) {
  if (signal.aborted) {
    const error = new Error("処理をキャンセルしました。");
    error.name = "AbortError";
    throw error;
  }
}

function createOutputSink(suggestedName, defaultType) {
  const canStream =
    globalThis.isSecureContext &&
    typeof window !== "undefined" &&
    typeof window.showSaveFilePicker === "function";

  if (canStream) {
    return (async function () {
      const handle = await window.showSaveFilePicker({ suggestedName });
      const writable = await handle.createWritable();
      let closed = false;
      return {
        kind: "stream",
        name: handle.name || suggestedName,
        async write(bytes) { await writable.write(bytes); },
        async close() {
          await writable.close();
          closed = true;
        },
        async abort() {
          if (closed) return;
          try { await writable.abort(); } catch (_) {}
        }
      };
    })();
  }

  let parts = [];
  return Promise.resolve({
    kind: "blob",
    name: suggestedName,
    async write(bytes) { parts.push(bytes); },
    async close(settings) {
      const options = settings || {};
      const blob = new Blob(parts, {
        type: options.type || defaultType || "application/octet-stream"
      });
      parts = [];
      downloadBlob(blob, options.filename || suggestedName);
      return blob.size;
    },
    async abort() { parts = []; }
  });
}

function createMetadata(nameBytes, typeBytes) {
  if (nameBytes.length < 1 || nameBytes.length > MAX_NAME_BYTES ||
      typeBytes.length < 1 || typeBytes.length > MAX_TYPE_BYTES) {
    throw new Error("ファイル名または種類の情報が上限を超えています。");
  }
  const metadata = concatBytes(
    writeUint32(nameBytes.length),
    writeUint32(typeBytes.length),
    nameBytes,
    typeBytes
  );
  if (metadata.length > MAX_METADATA_BYTES) {
    throw new Error("ファイル情報が大きすぎます。");
  }
  return metadata;
}

function parseMetadata(bytes) {
  if (bytes.length < 10 || bytes.length > MAX_METADATA_BYTES) {
    throw new Error("暗号化ファイルのメタデータ長が不正です。");
  }
  const nameLength = readUint32(bytes, 0);
  const typeLength = readUint32(bytes, 4);
  if (nameLength < 1 || nameLength > MAX_NAME_BYTES ||
      typeLength < 1 || typeLength > MAX_TYPE_BYTES ||
      8 + nameLength + typeLength !== bytes.length) {
    throw new Error("暗号化ファイルのメタデータが不正です。");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const name = decoder.decode(bytes.subarray(8, 8 + nameLength));
  const type = decoder.decode(bytes.subarray(8 + nameLength));
  if (safeMimeType(type) !== type) {
    throw new Error("暗号化ファイルの種類情報が不正です。");
  }
  return { name, type };
}

function createChunkHeader(plainSize, chunkCount, salt, noncePrefix, metadataLength) {
  const header = new Uint8Array(CHUNK_HEADER_LENGTH);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  header[4] = CHUNKED_VERSION;
  view.setUint32(5, CHUNK_SIZE, false);
  view.setBigUint64(9, BigInt(plainSize), false);
  view.setBigUint64(17, BigInt(chunkCount), false);
  header.set(salt, 25);
  header.set(noncePrefix, 57);
  view.setUint32(65, metadataLength, false);
  return header;
}

function parseChunkHeader(header, fileSize) {
  if (header.length !== CHUNK_HEADER_LENGTH ||
      header[0] !== MAGIC[0] || header[1] !== MAGIC[1] ||
      header[2] !== MAGIC[2] || header[3] !== MAGIC[3] ||
      header[4] !== CHUNKED_VERSION) {
    throw new Error("ABCD v2のファイルヘッダーではありません。");
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const chunkSize = view.getUint32(5, false);
  const plainSizeBig = view.getBigUint64(9, false);
  const chunkCountBig = view.getBigUint64(17, false);
  const metadataLength = view.getUint32(65, false);

  if (chunkSize !== CHUNK_SIZE ||
      plainSizeBig > BigInt(Number.MAX_SAFE_INTEGER) ||
      chunkCountBig > BigInt(MAX_CHUNKS)) {
    throw new Error("チャンク形式のサイズ上限またはチャンクサイズが不正です。");
  }

  const plainSize = Number(plainSizeBig);
  const chunkCount = Number(chunkCountBig);
  const expectedCount = plainSize === 0 ? 0 : Math.ceil(plainSize / CHUNK_SIZE);
  if (chunkCount !== expectedCount ||
      metadataLength < 26 ||
      metadataLength > MAX_METADATA_BYTES + 16) {
    throw new Error("ファイルサイズ、チャンク数、メタデータ長が一致しません。");
  }

  const expectedFileSize =
    BigInt(CHUNK_HEADER_LENGTH) + BigInt(metadataLength) +
    plainSizeBig + chunkCountBig * 16n;
  if (!Number.isSafeInteger(fileSize) || expectedFileSize !== BigInt(fileSize)) {
    throw new Error("ファイルが途中で切れているか、余分なデータがあります。");
  }

  return {
    header,
    plainSize,
    chunkCount,
    metadataLength,
    salt: header.slice(25, 57),
    noncePrefix: header.slice(57, 65)
  };
}

async function deriveChunkFileKey(masterBytes, salt) {
  const hkdfKey = await crypto.subtle.importKey(
    "raw", masterBytes, "HKDF", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("ABC Cipher chunked file v2 AES-256-GCM")
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function chunkNonce(prefix, counter) {
  return concatBytes(prefix, writeUint32(counter));
}

function metadataAAD(header, chunkCount) {
  return concatBytes(
    header,
    new TextEncoder().encode("ABCDF2-META"),
    writeUint32(0),
    writeUint64(chunkCount)
  );
}

function chunkAAD(header, chunkIndex, chunkCount, plainLength) {
  return concatBytes(
    header,
    new TextEncoder().encode("ABCDF2-CHUNK"),
    writeUint32(chunkIndex),
    writeUint64(chunkCount),
    writeUint32(plainLength)
  );
}

async function readBlobBytes(blob, signal, onProgress) {
  assertNotCancelled(signal);
  if (typeof FileReader === "undefined") {
    if (onProgress) onProgress(null, blob.size);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assertNotCancelled(signal);
    return bytes;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    function cleanup() { signal.removeEventListener("abort", abortRead); }
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    }
    function abortRead() {
      try { reader.abort(); }
      catch (_) {
        const error = new Error("処理をキャンセルしました。");
        error.name = "AbortError";
        finish(reject, error);
      }
    }

    signal.addEventListener("abort", abortRead, { once: true });
    reader.onprogress = event => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded, event.total);
    };
    reader.onload = () => finish(resolve, new Uint8Array(reader.result));
    reader.onerror = () => finish(reject, reader.error || new Error("ファイルを読み込めません。"));
    reader.onabort = () => {
      const error = new Error("処理をキャンセルしました。");
      error.name = "AbortError";
      finish(reject, error);
    };
    if (signal.aborted) { abortRead(); return; }
    reader.readAsArrayBuffer(blob);
  });
}

function outputNameSuggestion(file) {
  const name = file.name.replace(/\.abcdata$/i, "");
  return safeFilename(name || "decrypted_file");
}

function parseLegacyPayload(payload) {
  if (payload.length < 8) throw new Error("ABCD v1のファイル内容が短すぎます。");
  const nameLength = readUint32(payload, 0);
  let offset = 4;
  if (nameLength < 1 || nameLength > MAX_NAME_BYTES ||
      offset + nameLength + 4 > payload.length) {
    throw new Error("ABCD v1のファイル名情報が不正です。");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const name = decoder.decode(payload.subarray(offset, offset + nameLength));
  offset += nameLength;
  const typeLength = readUint32(payload, offset);
  offset += 4;
  if (typeLength < 1 || typeLength > MAX_TYPE_BYTES ||
      offset + typeLength > payload.length) {
    throw new Error("ABCD v1のファイル種類情報が不正です。");
  }

  const type = decoder.decode(payload.subarray(offset, offset + typeLength));
  offset += typeLength;
  return { name, type, data: payload.subarray(offset) };
}

async function encryptFile() {
  if (busy) return;
  setBusy(true);
  const controller = new AbortController();
  activeController = controller;
  let sink = null;
  let committed = false;

  try {
    requireCrypto();
    const file = document.getElementById("fileInput").files[0];
    if (!file) throw new Error("ファイルを選択してください。");
    if (file.name.toLowerCase().endsWith(".abcdata")) {
      throw new Error("暗号化済みファイルは復号機能を使用してください。");
    }
    if (!Number.isSafeInteger(file.size)) throw new Error("このファイルサイズには対応していません。");

    const masterBytes = getMasterKeyBytes();
    const chunkCount = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE);
    if (chunkCount > MAX_CHUNKS) throw new Error("ファイルがチャンク形式の上限を超えています。");

    const encoder = new TextEncoder();
    const metadata = createMetadata(
      encoder.encode(file.name),
      encoder.encode(safeMimeType(file.type || "application/octet-stream"))
    );
    const metadataLength = metadata.length + 16;
    const suggestedName = safeFilename(file.name + ".abcdata");

    updateFileProgress(
      "保存先を準備しています",
      0, file.size, 0, chunkCount,
      { indeterminate: true, detail: "保存先選択・暗号化準備中" }
    );
    // 保存先選択はクリック直後に始め、未完了データはcloseまで確定しない。
    sink = await createOutputSink(suggestedName, "application/octet-stream");
    activeSink = sink;
    assertNotCancelled(controller.signal);

    const salt = crypto.getRandomValues(new Uint8Array(32));
    const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
    const header = createChunkHeader(
      file.size, chunkCount, salt, noncePrefix, metadataLength
    );
    const fileKey = await deriveChunkFileKey(masterBytes, salt);
    assertNotCancelled(controller.signal);

    updateFileProgress("ファイルを暗号化しています", 0, file.size, 0, chunkCount);
    await sink.write(header);
    assertNotCancelled(controller.signal);

    const encryptedMetadata = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(noncePrefix, 0),
        tagLength: 128,
        additionalData: metadataAAD(header, chunkCount)
      },
      fileKey,
      metadata
    ));
    assertNotCancelled(controller.signal);
    await sink.write(encryptedMetadata);
    assertNotCancelled(controller.signal);

    let bytesDone = 0;
    for (let index = 0; index < chunkCount; index++) {
      assertNotCancelled(controller.signal);
      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const plainChunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
      if (plainChunk.length !== end - start) {
        throw new Error("入力ファイルの読み込み長が一致しません。");
      }

      const encryptedChunk = new Uint8Array(await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(noncePrefix, index + 1),
          tagLength: 128,
          additionalData: chunkAAD(header, index, chunkCount, plainChunk.length)
        },
        fileKey,
        plainChunk
      ));
      assertNotCancelled(controller.signal);
      updateFileProgress(
        "チャンク " + (index + 1).toLocaleString() + " / " +
          chunkCount.toLocaleString() + " を書き込み中",
        bytesDone, file.size, index, chunkCount
      );
      await sink.write(encryptedChunk);
      assertNotCancelled(controller.signal);
      bytesDone += plainChunk.length;
      updateFileProgress(
        "ファイルを暗号化しています",
        bytesDone, file.size, index + 1, chunkCount,
        { finalizing: index + 1 === chunkCount }
      );
    }

    assertNotCancelled(controller.signal);
    document.getElementById("cancelFileButton").disabled = true;
    updateFileProgress(
      "暗号化データを保存しています",
      bytesDone, file.size, chunkCount, chunkCount,
      { finalizing: true }
    );
    await sink.close({ filename: suggestedName, type: "application/octet-stream" });
    committed = true;

    updateFileProgress(
      "ファイル暗号化完了",
      file.size, file.size, chunkCount, chunkCount, { complete: true }
    );
    const outputSize =
      CHUNK_HEADER_LENGTH + metadataLength + file.size + chunkCount * 16;
    document.getElementById("fileResult").textContent =
      "暗号化成功（ABCD v2）\n" +
      "元のファイル：" + file.name + "\n" +
      "元のサイズ：" + file.size.toLocaleString() + " bytes\n" +
      "チャンク：" + chunkCount.toLocaleString() + "\n" +
      "保存方式：" + (sink.kind === "stream" ? "ストリーム" : "Blob") + "\n" +
      "暗号化ファイル：" + suggestedName + "\n" +
      "暗号化データサイズ：" + outputSize.toLocaleString() + " bytes";
    setStatus("ファイルの暗号化が完了しました。");
  } catch (error) {
    document.getElementById("fileResult").textContent = "";
    if (error.name === "AbortError") {
      updateFileProgress("キャンセルしました", 0, 0, 0, 0, {
        detail: "キャンセル済み · 未完成データは破棄しました。"
      });
      setStatus("ファイル暗号化をキャンセルしました。");
    } else {
      setStatus("ファイル暗号化エラー：" +
        (error.name === "OperationError" ? "暗号処理に失敗しました。" :
         error.message || "予期しないエラー"));
    }
    console.error("ABC Cipher ファイル暗号化エラー:", error);
  } finally {
    if (!committed && sink) await sink.abort();
    activeSink = null;
    activeController = null;
    setBusy(false);
  }
}

async function decryptFile() {
  if (busy) return;
  setBusy(true);
  const controller = new AbortController();
  activeController = controller;
  let sink = null;
  let committed = false;

  try {
    requireCrypto();
    const file = document.getElementById("fileInput").files[0];
    if (!file) throw new Error("復号するファイルを選択してください。");
    if (!file.name.toLowerCase().endsWith(".abcdata")) {
      throw new Error(".abcdataファイルを選択してください。");
    }

    const masterBytes = getMasterKeyBytes();
    updateFileProgress(
      "保存先を準備しています",
      0, 0, 0, 0,
      { indeterminate: true, detail: "保存先選択・ファイル形式確認中" }
    );
    sink = await createOutputSink(outputNameSuggestion(file), "application/octet-stream");
    activeSink = sink;
    assertNotCancelled(controller.signal);
    if (file.size < 5) throw new Error("ファイルが短すぎます。");

    const prefix = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (prefix[0] !== MAGIC[0] || prefix[1] !== MAGIC[1] ||
        prefix[2] !== MAGIC[2] || prefix[3] !== MAGIC[3]) {
      throw new Error("ABC Cipher形式ではありません。");
    }

    if (prefix[4] === VERSION) {
      if (file.size < 33) throw new Error("ABCD v1ファイルが短すぎます。");
      updateFileProgress("ABCD v1ファイルを読み込んでいます", 0, file.size, 0, 1);
      const packet = await readBlobBytes(file, controller.signal, (loaded, total) => {
        if (loaded !== null) {
          updateFileProgress("ABCD v1ファイルを読み込んでいます", loaded, total, 0, 1);
        } else {
          updateFileProgress(
            "ABCD v1ファイルを読み込んでいます",
            0, file.size, 0, 1, { indeterminate: true }
          );
        }
      });
      assertNotCancelled(controller.signal);
      checkMagic(packet);

      updateFileProgress(
        "ABCD v1を一括認証・復号しています",
        0, 0, 0, 1,
        {
          indeterminate: true,
          detail: "旧形式はAES-GCM一括処理のため、認証中の割合は取得できません。"
        }
      );
      const key = await crypto.subtle.importKey(
        "raw", masterBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
      );
      const payload = await decryptBytes(
        key, packet.slice(5, 17), packet.slice(17), MAGIC
      );
      assertNotCancelled(controller.signal);

      const parsed = parseLegacyPayload(payload);
      const outputName = safeFilename(parsed.name);
      const outputType = safeMimeType(parsed.type);
      updateFileProgress(
        "ABCD v1の復号データを書き込んでいます",
        0, parsed.data.length, 0, 1,
        { finalizing: true }
      );
      await sink.write(parsed.data);
      assertNotCancelled(controller.signal);

      document.getElementById("cancelFileButton").disabled = true;
      await sink.close({ filename: outputName, type: outputType });
      committed = true;
      updateFileProgress(
        "ABCD v1の復号完了",
        parsed.data.length, parsed.data.length, 1, 1, { complete: true }
      );
      document.getElementById("fileResult").textContent =
        "復号成功（ABCD v1互換）\n" +
        "元のファイル名：" + outputName + "\n" +
        "復号後サイズ：" + parsed.data.length.toLocaleString() + " bytes\n" +
        "保存先：" + (sink.kind === "stream" ? sink.name : outputName) + "\n" +
        "保存方式：" + (sink.kind === "stream" ? "ストリーム" : "Blob");
      setStatus("ABCD v1ファイルの復号・認証に成功しました。");
      return;
    }

    if (prefix[4] !== CHUNKED_VERSION) {
      throw new Error("未対応のABCDファイルバージョンです。");
    }
    if (file.size < CHUNK_HEADER_LENGTH) {
      throw new Error("ABCD v2ヘッダーが途中で切れています。");
    }

    const header = new Uint8Array(
      await file.slice(0, CHUNK_HEADER_LENGTH).arrayBuffer()
    );
    const parsedHeader = parseChunkHeader(header, file.size);
    const fileKey = await deriveChunkFileKey(masterBytes, parsedHeader.salt);
    assertNotCancelled(controller.signal);

    const metadataStart = CHUNK_HEADER_LENGTH;
    const metadataEnd = metadataStart + parsedHeader.metadataLength;
    const encryptedMetadata = new Uint8Array(
      await file.slice(metadataStart, metadataEnd).arrayBuffer()
    );
    if (encryptedMetadata.length !== parsedHeader.metadataLength) {
      throw new Error("メタデータが途中で切れています。");
    }

    const metadataBytes = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(parsedHeader.noncePrefix, 0),
        tagLength: 128,
        additionalData: metadataAAD(header, parsedHeader.chunkCount)
      },
      fileKey,
      encryptedMetadata
    ));
    assertNotCancelled(controller.signal);

    const metadata = parseMetadata(metadataBytes);
    const outputName = safeFilename(metadata.name);
    const outputType = safeMimeType(metadata.type);
    let offset = metadataEnd;
    let bytesDone = 0;
    updateFileProgress(
      "メタデータを認証しました。チャンクを復号しています",
      0, parsedHeader.plainSize, 0, parsedHeader.chunkCount
    );

    for (let index = 0; index < parsedHeader.chunkCount; index++) {
      assertNotCancelled(controller.signal);
      const expectedLength = Math.min(
        CHUNK_SIZE, parsedHeader.plainSize - bytesDone
      );
      const encryptedLength = expectedLength + 16;
      const encryptedChunk = new Uint8Array(
        await file.slice(offset, offset + encryptedLength).arrayBuffer()
      );
      if (encryptedChunk.length !== encryptedLength) {
        throw new Error("チャンクが途中で切れています。");
      }

      const plainChunk = new Uint8Array(await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(parsedHeader.noncePrefix, index + 1),
          tagLength: 128,
          additionalData: chunkAAD(
            header, index, parsedHeader.chunkCount, expectedLength
          )
        },
        fileKey,
        encryptedChunk
      ));
      assertNotCancelled(controller.signal);
      if (plainChunk.length !== expectedLength) {
        throw new Error("復号したチャンク長が一致しません。");
      }

      updateFileProgress(
        "チャンク " + (index + 1).toLocaleString() + " / " +
          parsedHeader.chunkCount.toLocaleString() + " を書き込み中",
        bytesDone, parsedHeader.plainSize, index, parsedHeader.chunkCount
      );
      await sink.write(plainChunk);
      assertNotCancelled(controller.signal);
      bytesDone += plainChunk.length;
      offset += encryptedLength;
      updateFileProgress(
        "ファイルを復号・認証しています",
        bytesDone, parsedHeader.plainSize, index + 1, parsedHeader.chunkCount,
        { finalizing: index + 1 === parsedHeader.chunkCount }
      );
    }

    if (offset !== file.size || bytesDone !== parsedHeader.plainSize) {
      throw new Error("復号後サイズがヘッダーと一致しません。");
    }
    assertNotCancelled(controller.signal);
    document.getElementById("cancelFileButton").disabled = true;
    updateFileProgress(
      "復号データを保存しています",
      bytesDone, parsedHeader.plainSize,
      parsedHeader.chunkCount, parsedHeader.chunkCount,
      { finalizing: true }
    );
    await sink.close({ filename: outputName, type: outputType });
    committed = true;

    updateFileProgress(
      "ファイル復号完了",
      bytesDone, parsedHeader.plainSize,
      parsedHeader.chunkCount, parsedHeader.chunkCount,
      { complete: true }
    );
    document.getElementById("fileResult").textContent =
      "復号成功（ABCD v2）\n" +
      "元のファイル名：" + outputName + "\n" +
      "復号後サイズ：" + bytesDone.toLocaleString() + " bytes\n" +
      "チャンク：" + parsedHeader.chunkCount.toLocaleString() + "\n" +
      "保存先：" + (sink.kind === "stream" ? sink.name : outputName) + "\n" +
      "保存方式：" + (sink.kind === "stream" ? "ストリーム" : "Blob");
    setStatus("ABCD v2の全チャンクの認証・復号に成功しました。");
  } catch (error) {
    document.getElementById("fileResult").textContent = "";
    if (error.name === "AbortError") {
      updateFileProgress("キャンセルしました", 0, 0, 0, 0, {
        detail: "キャンセル済み · 未完成データは破棄しました。"
      });
      setStatus("ファイル復号をキャンセルしました。");
    } else if (error.name === "OperationError") {
      setStatus("復号失敗：鍵が一致しないか、ファイルが破損しています。");
    } else {
      setStatus("ファイル復号エラー：" + (error.message || "予期しないエラー"));
    }
    console.error("ABC Cipher ファイル復号エラー:", error);
  } finally {
    if (!committed && sink) await sink.abort();
    activeSink = null;
    activeController = null;
    setBusy(false);
  }
}

// ==========================================// コピー
// ==========================================

async function copyText(id) {
  try {
    const text = document.getElementById(id).textContent;

    if (!text) throw new Error("コピーする内容がありません。");

    await navigator.clipboard.writeText(text);
    setStatus("コピーしました。");
  } catch (error) {
    setStatus("コピーできませんでした。");
  }
}

// ==========================================
// 全クリア
// ==========================================

function clearAll() {
  if (busy) {
    setStatus("処理が終わってからクリアしてください。");
    return;
  }

  document.getElementById("plain").value = "";
  document.getElementById("cipher").value = "";

  document.getElementById("encrypted").textContent = "";
  document.getElementById("decrypted").textContent = "";
  document.getElementById("fileResult").textContent = "";

  document.getElementById("fileInput").value = "";
  document.getElementById("keyFile").value = "";

  document.getElementById("fileInfo").textContent =
    "ファイルは選択されていません。";

  setStatus("入力・結果・ファイル選択をクリアしました。");
}

// ファイル選択情報
document.getElementById("fileInput").addEventListener(
  "change",
  function () {
    const file = this.files[0];

    document.getElementById("fileInfo").textContent = file
      ? "選択中：" + file.name +
        " (" + file.size.toLocaleString() + " bytes)"
      : "ファイルは選択されていません。";
  }
);

// ========================================
// Service Worker 登録
// ========================================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .then(registration => {
        console.log(
          "ABC Cipher Service Worker registered:",
          registration.scope
        );
      })
      .catch(error => {
        console.error(
          "Service Worker registration failed:",
          error
        );
      });
  });
}

/* ========================================
   PWA インストール機能
======================================== */

let deferredInstallPrompt = null;

const installButton = document.getElementById("install-button");
const installMessage = document.getElementById("install-message");

// インストール済みか確認
function isAppInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
}

// インストールボタンの初期設定
if (installButton) {

  // インストール済みならボタンを表示しない
  if (isAppInstalled()) {
    installButton.hidden = true;
  }

  // インストール可能になったとき
  window.addEventListener("beforeinstallprompt", event => {

    // ブラウザ標準の自動表示を抑制
    event.preventDefault();

    // イベントを保存
    deferredInstallPrompt = event;

    // ボタンを表示
    installButton.hidden = false;
  });

  // ボタンが押されたとき
  installButton.addEventListener("click", async () => {

    if (!deferredInstallPrompt) {
      return;
    }

    // インストール確認画面を表示
    deferredInstallPrompt.prompt();

    // 利用者の選択を取得
    const result = await deferredInstallPrompt.userChoice;

    if (installMessage) {
      if (result.outcome === "accepted") {
        installMessage.textContent =
          "インストールが開始されました。";
      } else {
        installMessage.textContent =
          "インストールはキャンセルされました。";
      }
    }

    // イベントは再利用できないため破棄
    deferredInstallPrompt = null;

    // ボタンを非表示
    installButton.hidden = true;
  });

  // インストールが完了したとき
  window.addEventListener("appinstalled", () => {

    installButton.hidden = true;

    if (installMessage) {
      installMessage.textContent =
        "ABC Cipherのインストールが完了しました！";
    }

    deferredInstallPrompt = null;
  });
}
