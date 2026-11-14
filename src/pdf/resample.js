// 面積平均縮圖：每個輸出像素取它蓋到的來源像素（含部分覆蓋）的加權平均。
// 只用來縮小；比雙線性取樣慢一點，但大倍率縮小時不會有鋸齒和摩爾紋。

/** 一個軸上的權重表：輸出第 i 格取來源 [start[i], start[i]+count[i]) 這幾格，權重依序放在 weight 裡。 */
function axis(src, dst) {
  const scale = src / dst
  const start = new Int32Array(dst)
  const count = new Int32Array(dst)
  const weights = []
  for (let i = 0; i < dst; i++) {
    const a = i * scale
    const b = a + scale
    const s = Math.floor(a)
    const e = Math.min(src, Math.ceil(b))
    start[i] = s
    count[i] = e - s
    for (let j = s; j < e; j++) weights.push((Math.min(b, j + 1) - Math.max(a, j)) / scale)
  }
  return { start, count, weight: Float32Array.from(weights) }
}

/**
 * @param {ArrayLike<number>} src 來源樣本，每列 `stride` 個位元組、每像素 `n` 個分量
 * @returns {Uint8ClampedArray} dw×dh×n，緊密排列
 */
export function downsample(src, sw, sh, n, stride, dw, dh) {
  const xs = axis(sw, dw)
  const ys = axis(sh, dh)
  const line = dw * n
  // 逐列做：來源列先橫向縮成 dw 寬，再依權重累加到輸出列。相鄰兩個輸出列會共用邊界那一列，
  // 留著上一次算的就不必重算。整張圖只需要兩列的暫存，幾億像素的掃描檔也不會爆記憶體。
  const row = new Float32Array(line)
  let rowAt = -1
  const acc = new Float32Array(line)
  const out = new Uint8ClampedArray(line * dh)
  for (let y = 0, k = 0; y < dh; y++) {
    acc.fill(0)
    for (let j = 0; j < ys.count[y]; j++) {
      const sy = ys.start[y] + j
      if (sy !== rowAt) {
        const s = sy * stride
        for (let x = 0, kx = 0; x < dw; x++) {
          const p = s + xs.start[x] * n
          const m = xs.count[x]
          for (let c = 0; c < n; c++) {
            let v = 0
            for (let i = 0; i < m; i++) v += src[p + i * n + c] * xs.weight[kx + i]
            row[x * n + c] = v
          }
          kx += m
        }
        rowAt = sy
      }
      const w = ys.weight[k + j]
      for (let i = 0; i < line; i++) acc[i] += row[i] * w
    }
    k += ys.count[y]
    out.set(acc, y * line) // Uint8ClampedArray 會四捨五入並夾在 0–255
  }
  return out
}
