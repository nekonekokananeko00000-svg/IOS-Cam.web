# 実機計測の記録

`diag.html` の結果をここに貼り、端末ごとの実力を記録する。
設計上の前提（解像度・合成枚数・`takePhoto` の扱い）はこの記録に従って決める。

## 記録の手順

1. GitHub Pages などの HTTPS で `diag.html` を開く
2. 上から順にボタンを実行する（6 は**音量を上げ、消音スイッチを解除**して行う）
3. 「結果をコピー」で JSON を取り出し、下に追記する（`deviceId` / `groupId` は端末固有の識別子なので伏せる）

## 特に確認したいこと

- [x] `getUserMedia` で実際に得られる最大解像度 → **2160×3840 @30fps**
- [x] `powerEfficientPixelFormat` で binned を回避できるか → **変化なし**（制約名は `powerEfficient` が正しい）
- [x] `grabFrame` が `drawImage` より速いか → **遅い**（34ms 対 ほぼ 0ms）
- [x] **`takePhoto()` でシャッター音が鳴るか** → **鳴らなかった**（素の `takePhoto()`・480×640 セッション）
- [x] `takePhoto()` の解像度が映像トラックより大きいか → **同じだった**（480×640）
- [ ] 4K セッションでも無音か／解像度と画質はどうか（比較セクションで計測する）
- [x] 連写の実効 fps → コールバックは 30.4fps。ただし 4K 実撮影は 12 枚で約 3.8 秒
- [x] WebGL2 の浮動小数レンダーターゲット → 使える。GPU/CPU 一致テストも通る
- [ ] ホーム画面から起動したときにカメラ許可が保持されるか

---

## 端末: iPhone / iOS 18.7・Safari 26.6.1（2026-09-21）

UA: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6.1 Mobile/15E148 Safari/604.1`

### 要点

| 項目 | 実測 |
|---|---|
| 最大解像度 | **2160×3840 @30fps**（横で要求しても縦で返る） |
| 写真の能力 | `imageWidth.max 4032` / `imageHeight.max 3024` |
| フレーム取得 | grabFrame **34.0ms** / VideoFrame 0.0ms / drawImage 0.0ms（480×640 時） |
| VideoFrame の向き | **640×480（横）を返す** — video 要素は 480×640。回転が入る |
| 連写 | rVFC 30.4fps（480×640）。4K の実撮影は 12 枚で約 3.8 秒 |
| カメラ制御 | **zoom 0.5–10 / torch あり / whiteBalanceMode（manual, continuous）** |
| 露出制御 | 能力に現れない（露出ブラケットは不可） |
| GPU | Apple GPU・WebGL2・float RT 可・WebGPU 可・maxTexture 16384 |
| 合成速度 | 1920×1080 を 10 枚: 等倍 192ms / 2 倍格子 386ms |
| 自己テスト | GPU と CPU が maxDiff 0 で一致 |
| 書き出し | `toBlob` が `image/heic` と `image/avif` を返した（**実体は要再検証**） |
| 色 | display-p3 canvas 可 |
| その他 | standalone で起動・WakeLock 可・共有シートでファイル共有可・MediaStreamTrackProcessor なし |

### 所見

- **4K が使える。** 初期に見かけた「iOS Safari は 720p まで」という記述は現行では誤り。
- **`takePhoto()` は最大解像度を要求すると `IPC Connection closed` で落ちた。**
  480×640 のセッションに 4032×3024 を要求したのが原因と見ている（仮定）。
  そのため既定を「設定なしの `takePhoto()`」に変更し、最大要求は任意トグルへ降格した。
  **日本版端末で音が鳴るかは依然未確定**で、素の `takePhoto()` での再検証が必要。
- **`grabFrame` は遅い。** 480×640 でも 34ms かかる。起動時に経路を実測し、
  正しい向きを返すもののうち最速を既定にする方式へ変更した。
- **`new VideoFrame(video)` は回転したフレームを返す。** 向きが video 要素と食い違う経路は使わない。
- **ズームが 0.5 から使える** = 超広角に切り替わる。0.5× / 1× / 2× のクイックボタンを追加した。
- 4K の `createImageBitmap` が重く、12 枚で 3.8 秒かかっていた。連写は video 要素を
  直接 GPU へ上げる方式に変更（枚数あたりのコピーを 1 回減らした）。効果は次回計測で確認する。
- `toBlob('image/heic')` が `image/heic` を返したのは一般に知られている挙動（未対応なら PNG）と食い違う。
  先頭バイトと再デコードで実体を確かめる検査を `diag.html` に追加した。本物なら保存形式に加える。

### 生データ（端末識別子は伏せてある）

```json
{
  "generatedAt": "2026-09-21T13:30:28.317Z",
  "environment": {
    "standalone": true, "secureContext": true, "devicePixelRatio": 2, "screen": "414x896",
    "silentPaths": { "grabFrame": true, "videoFrame": true, "drawImage": true },
    "imageCapture": true, "takePhoto": true, "webCodecs": true,
    "mediaStreamTrackProcessor": false, "webgpu": true, "offscreenCanvas": true,
    "wakeLock": true, "shareFiles": true
  },
  "opened": {
    "facingMode": "environment", "label": "背面デュアル広角カメラ",
    "width": 480, "height": 640, "frameRate": 30,
    "settings": {
      "aspectRatio": 0.75, "backgroundBlur": false, "facingMode": "environment",
      "frameRate": 30, "height": 640, "powerEfficient": false, "torch": false,
      "whiteBalanceMode": "continuous", "width": 480, "zoom": 1
    },
    "capabilities": {
      "aspectRatio": { "max": 4032, "min": 0.00033068783068783067 },
      "backgroundBlur": [false], "facingMode": ["environment"],
      "focusDistance": { "min": 0.12 }, "frameRate": { "max": 60, "min": 1 },
      "height": { "max": 3024, "min": 1 }, "powerEfficient": [false, true],
      "torch": true, "whiteBalanceMode": ["manual", "continuous"],
      "width": { "max": 4032, "min": 1 }, "zoom": { "max": 10, "min": 0.5 }
    }
  },
  "resolutionLadder": [
    { "requested": "3840×2160", "binned": "既定", "actual": "2160×3840", "fps": 30 },
    { "requested": "3840×2160", "binned": "抑止", "actual": "2160×3840", "fps": 30 },
    { "requested": "1920×1440", "binned": "既定", "actual": "1440×1920", "fps": 30 },
    { "requested": "1920×1440", "binned": "抑止", "actual": "1440×1920", "fps": 30 },
    { "requested": "1920×1080", "binned": "既定", "actual": "1080×1920", "fps": 30 },
    { "requested": "1920×1080", "binned": "抑止", "actual": "1080×1920", "fps": 30 },
    { "requested": "1280×720",  "binned": "既定", "actual": "720×1280",  "fps": 30 },
    { "requested": "1280×720",  "binned": "抑止", "actual": "720×1280",  "fps": 30 },
    { "requested": "640×480",   "binned": "既定", "actual": "480×640",   "fps": 30 },
    { "requested": "640×480",   "binned": "抑止", "actual": "480×640",   "fps": 30 }
  ],
  "photoCapabilities": {
    "imageHeight": { "max": 3024, "min": 1, "step": 1 },
    "imageWidth": { "max": 4032, "min": 1, "step": 1 }
  },
  "framePaths": [
    { "path": "grabFrame",  "size": "480×640", "median": "34.0ms" },
    { "path": "videoFrame", "size": "640×480", "median": "0.0ms" },
    { "path": "drawImage",  "size": "480×640", "median": "0.0ms" }
  ],
  "burst": { "callbackFps": 30.4, "bitmapFps": 30.4, "api": "requestVideoFrameCallback" },
  "takePhoto": { "supported": true, "error": "IPC Connection closed" },
  "gpu": {
    "webgl2": true, "floatRenderTarget": true, "webgpu": true, "maxTextureSize": 16384,
    "renderer": "Apple GPU",
    "stack10x1Ms": 192, "output1x": "1920×1080", "accumFormat1x": "rgba32f",
    "stack10x2Ms": 386, "output2x": "3840×2160", "accumFormat2x": "rgba16f"
  },
  "selfTest": { "size": 96, "frames": 4, "maxDiff": 0, "meanDiff": 0, "verdict": "ok（一致）" },
  "encode": {
    "displayP3Canvas": true,
    "toBlob": {
      "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/png",
      "image/heic": "image/heic", "image/avif": "image/avif"
    }
  }
}
```

### このとき見つかった不具合（修正済み）

- **合成結果が上下反転していた。** WebGL の仕様上、**ImageBitmap を入力にすると
  `UNPACK_FLIP_Y_WEBGL` が無視される**（canvas や video 要素では効く）。合成は
  `createImageBitmap()` の結果を GPU へ上げていたため、上下が食い違っていた。
  シェーダ内で画像座標系へ変換する方式に変更し、入力の種類によらず同じ結果になるようにした。
  診断ページの自己テストが canvas 入力だけだったため見逃していたので、
  **ImageBitmap 入力の自己テストを追加**した（バグを戻すと maxDiff 140 で確実に落ちる）。


---

## 2 回目の計測（2026-09-21・上下反転の修正後）

### 決定的な結果: **`takePhoto()` は無音だった**

```json
"takePhoto": {
  "supported": true, "maxSizeRequested": false,
  "photoSize": "480×640", "videoSize": "480×640", "largerThanVideo": false,
  "type": "image/jpeg", "bytes": 227363, "elapsedMs": 1303,
  "trackAliveAfter": true, "shutterSound": "silent"
}
```

同じ端末でスクリーンショット時にはシャッター音が鳴る（＝日本国内向け端末）にもかかわらず、
Safari の `takePhoto()` では鳴らなかった。

**WebKit のソースを確認した結果、音を抑止するコードは存在しない。**
`AVVideoCaptureSource::photoConfiguration()` は
`photoSettingsWithFormat:{AVVideoCodecKey: JPEG, AVVideoQualityKey: 1}` を組み立てて
`capturePhotoWithSettings:` に渡すだけで、`shutterSoundSuppression` には触れていない。
つまり **WebKit が止めているのではなく、この経路が OS の強制対象から外れている**。
Apple が意図した挙動とは限らず、**将来の iOS で鳴るようになる可能性がある**。
→ 写真撮影 API を通らない「即写」「合成」は保険として残す。

### そのほか

| 項目 | 結果 |
|---|---|
| `takePhoto()` の所要時間 | **1303ms**。連写・合成には使えない |
| JPEG の品質 | WebKit が `AVVideoQualityKey: 1`（最高品質）で符号化。227KB / 480×640 |
| 最大解像度の要求 | 依然 `IPC Connection closed`。ただし**今回はトラックが生存**した |
| 上下反転の修正 | canvas 入力・ImageBitmap 入力とも **maxDiff 0**、上下反転版との差は 141 → 修正を確認 |
| `videoFrame` 経路 | 「回転」と判定され、自動的に除外された（480×640 に対し 640×480 を返す） |
| `grabFrame` | 34ms。`drawImage` はほぼ 0ms |
| HEIC / AVIF / WebP | `blob.type` は `image/heic` などを返すが、**実体は PNG**。実体検査が正しく弾いた |
| GPU 合成 | 1920×1080 を 10 枚で 370ms（等倍）／367ms（2 倍格子） |

`toBlob` の件は「未対応形式は PNG にフォールバックする」という HTML の仕様どおりで、
`blob.type` だけを見ていると HEIC で保存できていると誤解する。実体（先頭バイト）と
再デコードまで見る検査を入れてあるので、保存形式の選択肢には **JPEG と PNG だけ**が出る。

### 次に測ること

`diag.html` の「10. 写真API と フレーム切り出しの比較」を 720p / 1080p / 4K で実行し、
解像度・バイト数・所要時間・シャープネス（ラプラシアン分散）・ノイズ（平坦部の標準偏差）を比べる。
「11. 要求サイズの上限」でどこからクラッシュするかも調べる。
その結果で既定モードを決める。

---

## 3 回目の計測（2026-09-21・写真API とフレーム切り出しの比較）

### 比較結果

| セッション | 方式 | 解像度 | バイト | 所要 | シャープ↑ | ノイズ↓ |
|---|---|---|---|---|---|---|
| 720×1280 | 単写 | 同じ | 631KB | 1408 → 335 / 348ms | 1868 / 1927 / 1898 | 1.67–1.98 |
| | 即写 | 同じ | 377KB | **45ms** | **2124** | 1.78 |
| 1080×1920 | 単写 | 同じ | 1.2–1.6MB | 1024 → 378 / 361ms | 2275 / 3554 / 4569 | 2.14–3.46 |
| | 即写 | 同じ | 790KB | **51ms** | 2620 | **2.23** |
| 2160×3840 | 単写 | 同じ | 3.9–6.9MB | 1236 → 589 / 571ms | 518 / 2146 / 2225 | 1.43–5.43 |
| | 即写 | 同じ | 2.77MB | **214ms** | 1485 | **2.38** |

**全解像度で `shutterSound: "silent"`。4K でも無音だった。**

### 要求サイズの上限

| 要求 | 結果 |
|---|---|
| ×1（2160×3840） | 2160×3840 |
| ×1.5（3240×5760） | **2160×3840 に丸められる** |
| ×2（4320×7680） | **2160×3840 に丸められる** |
| 能力値の最大（4032×3024） | **× IPC Connection closed** |

×1.5 も ×2 も丸められ、落ちたのは能力値の最大だけだった。これは映像と縦横比が違う
（4032×3024 は横長、映像は縦長）サイズを要求したときに壊れる、と読める。
**要求して得られるものは無い**ので、アプリからはサイズを要求しない実装にした。

### 読み取り方の注意

- ラプラシアン分散（シャープ）は**ノイズもディテールとして数える**。単写でシャープが高い回は
  ノイズも一緒に上がっており、**実際に解像しているとは言い切れない**
- 単写 3 枚 → 即写の順に撮っているため、露出条件が完全には揃っていない
- **各段の 1 枚目だけ挙動が違う**（4K でシャープ 518 = 明らかに甘い）。
  写真パイプラインの初回は焦点・露出が落ち着く前に撮れていると見られる

### 結論

- **解像度の利得は無い**（どの段でも映像と同じ画素数）
- **速度差は 5〜10 倍**（即写 45–214ms に対し、単写は温まって 335–589ms、初回 1.0–1.4 秒）
- 画質の優劣は条件依存で、決定打が無い
- → **既定は即写のまま**。単写は「品質 1.0 の JPEG を再エンコードなしで受け取る」選択肢として残す。
  合成は単写では代替できない（連写できないため）

## カメラ許可の持続について

ホーム画面 Web アプリは起動のたびに新しい文書になるため、前回の許可が残っていないと
毎回プロンプトが出る。WebKit 側の制約で確実に持続させる方法は無いので、
**出さずに済むプロンプトを全部なくす**方向で実装した。

- 起動時に `getUserMedia` を呼ぶ前に許可状態を推定し（Permissions API ＋
  `enumerateDevices()` のラベル）、残っていれば**開始ボタンを待たずにカメラを開く**
- 解像度の変更は `applyConstraints` を先に試し、失敗したときだけ開き直す
- バックグラウンド復帰では、トラックが生きていれば何もしない（以前は必ず停止 → 再取得していた）
- 診断ページへの遷移は、別文書になる旨を確認してから移動する

`diag.html` の「0b. 許可の持続」を**アプリを閉じて開き直してから**実行すると、
その端末で許可が残るかどうかが分かる。
