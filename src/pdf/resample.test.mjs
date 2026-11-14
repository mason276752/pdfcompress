import { test } from 'vitest'
import assert from 'node:assert/strict'
import { downsample } from './resample.js'

test('整數倍縮小就是區塊平均', () => {
  // 4×2 灰階 → 2×1
  const src = Uint8Array.from([0, 100, 10, 20, 50, 250, 30, 40])
  assert.deepEqual([...downsample(src, 4, 2, 1, 4, 2, 1)], [100, 25])
})

test('多分量各自平均，並跳過每列尾端的填充位元組', () => {
  // 2×2 RGB，每列 8 個位元組（6 個樣本＋2 個填充）
  const src = Uint8Array.from([
    255, 0, 0, 0, 0, 255, 99, 99,
    255, 0, 0, 0, 0, 255, 99, 99,
  ])
  assert.deepEqual([...downsample(src, 2, 2, 3, 8, 1, 1)], [128, 0, 128])
})

test('非整數倍：純色維持純色，平均亮度不變', () => {
  const w = 37, h = 23
  const flat = new Uint8Array(w * h).fill(200)
  assert.ok(downsample(flat, w, h, 1, w, 10, 7).every((v) => v === 200))

  const ramp = Uint8Array.from({ length: w * h }, (_, i) => (i % w) * 6)
  const out = downsample(ramp, w, h, 1, w, 11, 5)
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
  assert.ok(Math.abs(mean(out) - mean(ramp)) < 0.6)
})
