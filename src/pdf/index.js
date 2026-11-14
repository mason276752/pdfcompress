// 主執行緒這一側：兩個 Worker（見 worker.js），一個壓縮、一個畫預覽——壓縮大檔的時候翻頁比較才不會卡住。

class Engine {
  worker = null
  jobs = new Map()

  call(msg, transfer = [], onStage) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      this.jobs.set(id, { resolve, reject, onStage })
      this.get().postMessage({ ...msg, id }, transfer)
    })
  }

  get() {
    if (this.worker) return this.worker
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e) => {
      const { id, stage, error, code } = e.data
      const job = this.jobs.get(id)
      if (!job) return
      if (stage) {
        job.onStage?.(stage, e.data.done, e.data.total)
        return
      }
      this.jobs.delete(id)
      if (error) job.reject(Object.assign(new Error(error), { code }))
      else job.resolve(e.data)
    }
    this.worker.onerror = (e) => this.fail(new Error(`無法啟動 PDF 引擎：${e.message || '瀏覽器不支援'}`))
    return this.worker
  }

  /** 收掉 Worker（WASM 在 HTTP 快取裡，重新載入很快），進行中的工作一律以 `err` 結束。 */
  fail(err) {
    this.worker?.terminate()
    this.worker = null
    for (const job of this.jobs.values()) job.reject(err)
    this.jobs.clear()
  }
}

const compressor = new Engine()
const previewer = new Engine()

/**
 * 壓縮一份 PDF。`bytes` 會被轉移給 Worker。
 *
 * @param {ArrayBuffer} bytes
 * @param {{ dpi: number, quality: number, password?: string }} opts
 * @param {(stage: 'load'|'scan'|'images'|'save', done?: number, total?: number) => void} onStage
 * @returns {Promise<{ bytes: Uint8Array, pages: number, stats: object, repaired: boolean }>}
 */
export function compress(bytes, opts, onStage) {
  return compressor.call({ type: 'compress', bytes, opts }, [bytes], onStage)
}

/** 中斷進行中的壓縮。 */
export function cancelCompress() {
  compressor.fail(new Error('已取消'))
}

/**
 * 把第 `page` 頁畫成 `width` 像素寬的 PNG。同一個 `key` 的文件第一次才需要傳位元組過去。
 *
 * @param {() => Promise<ArrayBuffer>} getBytes
 * @returns {Promise<{ png: Uint8Array, pages: number, width: number, height: number }>}
 */
export async function renderPage(key, getBytes, page, width, password) {
  const msg = { type: 'render', key, page, width, password }
  try {
    return await previewer.call(msg)
  } catch (err) {
    if (err.code !== 'missing') throw err
    const bytes = await getBytes()
    return previewer.call({ ...msg, bytes }, [bytes])
  }
}

/** 關掉預覽 Worker 裡 key 以 `prefix` 開頭的文件。 */
export function forget(prefix) {
  previewer.worker?.postMessage({ type: 'forget', prefix })
}
