import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/pdfcompress/',
  // mupdf.js 用頂層 await 載入 WASM，需要 ES2022；壓縮跑在 module worker 裡（見 src/pdf/）。
  build: { target: 'es2022' },
  worker: { format: 'es' },
  // mupdf 用 `new URL('mupdf-wasm.wasm', import.meta.url)` 找它的 WASM，正式建置時 Vite 會把它當成
  // 資源一起輸出；開發時預先打包會弄斷這個相對路徑，所以排除。
  optimizeDeps: { exclude: ['mupdf'] },
  test: {
    include: ['src/**/*.test.mjs'],
  },
})
