# 実機計測の記録

`diag.html` の結果をここに貼り、端末ごとの実力を記録する。
設計上の前提（解像度・合成枚数・`takePhoto` の扱い）はこの記録に従って決める。

## 記録の手順

1. GitHub Pages などの HTTPS で `diag.html` を開く
2. 上から順にボタンを実行する（6 は**音量を上げ、消音スイッチを解除**して行う）
3. 「結果をコピー」で JSON を取り出し、下に追記する

## 特に確認したいこと

- [ ] `getUserMedia` で実際に得られる最大解像度（要求値ではなく `getSettings()` の値）
- [ ] `powerEfficientPixelFormat: false` で binned プリセットを回避できるか
- [ ] `grabFrame` が `drawImage` より速い／高解像か
- [ ] **`takePhoto()` でシャッター音が鳴るか**（本プロジェクトの最重要事項）
- [ ] `takePhoto()` の解像度が映像トラックより大きいか
- [ ] 連写の実効 fps（合成枚数の上限を決める）
- [ ] WebGL2 の浮動小数レンダーターゲットが使えるか、GPU/CPU 一致テストの結果
- [ ] ホーム画面から起動したときにカメラ許可が保持されるか

## 端末: （例）iPhone ○○ / iOS ○○

```json
（ここに diag.html の JSON を貼る）
```

所見:

-
