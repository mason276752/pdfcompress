// 在 Web Worker 裡跑 MuPDF（WASM，約 10MB，第一次用到時才載入）。
//
// 訊息：
//   → {id, type: 'compress', bytes, opts}       bytes 是 ArrayBuffer（轉移過來）
//   ← {id, stage, done, total}                  stage: 'load' | 'scan' | 'images' | 'save'
//   ← {id, bytes, pages, stats, repaired}
//   → {id, type: 'render', key, bytes?, page, width, password?}
//                                               key 對應一份打開的文件；沒帶 bytes 而 key 不在快取裡會回 code: 'missing'
//   ← {id, png, pages, width, height}           width／height 是頁面大小（點）
//   → {type: 'forget', prefix}                  關掉 key 以 prefix 開頭的文件
//   ← {id, error, code?}                        code: 'password' | 'broken' | 'missing'

// MuPDF 解析有瑕疵的檔案時會印一堆「warning: repairing…」，對使用者沒有意義，降成 debug。
globalThis.$libmupdf_wasm_Module = { printErr: (s) => console.debug(s) }

// mupdf 用頂層 await 載入 WASM；改成動態 import，onmessage 才能先掛上，載入期間收到的訊息不會掉。
let engine = null
const load = () =>
  (engine ??= Promise.all([import('./compress.js'), import('mupdf')]).then(([{ compressPdf }, mupdf]) => ({ compressPdf, mupdf })))

// ---------- 預覽：一次留幾份打開的文件，翻頁時不必每次重新解析 ----------
const MAX_OPEN = 4
const open = new Map() // key → PDFDocument（Map 依插入順序，最久沒用的在最前面）

function docFor(mupdf, key, bytes, password) {
  let doc = open.get(key)
  if (doc) {
    open.delete(key)
    open.set(key, doc)
    return doc
  }
  if (!bytes) throw Object.assign(new Error('missing'), { code: 'missing' })
  doc = new mupdf.PDFDocument(new Uint8Array(bytes))
  if (doc.needsPassword() && !doc.authenticatePassword(password || '')) {
    doc.destroy()
    throw Object.assign(new Error('這個 PDF 需要密碼才能打開'), { code: 'password' })
  }
  open.set(key, doc)
  for (const [k, d] of open) {
    if (open.size <= MAX_OPEN) break
    d.destroy()
    open.delete(k)
  }
  return doc
}

function render(mupdf, { key, bytes, page, width, password }) {
  const doc = docFor(mupdf, key, bytes, password)
  const pages = doc.countPages()
  const p = doc.loadPage(Math.min(page, pages - 1))
  const [x0, y0, x1, y1] = p.getBounds()
  const scale = width / (x1 - x0)
  const pix = p.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = pix.asPNG().slice()
  pix.destroy()
  p.destroy()
  return { png, pages, width: x1 - x0, height: y1 - y0 }
}

self.onmessage = async (e) => {
  const m = e.data
  if (m.type === 'forget') {
    for (const [k, d] of open) {
      if (k.startsWith(m.prefix)) {
        d.destroy()
        open.delete(k)
      }
    }
    return
  }
  const { id } = m
  try {
    if (!engine) self.postMessage({ id, stage: 'load' })
    const { compressPdf, mupdf } = await load()
    if (m.type === 'compress') {
      const r = compressPdf(new Uint8Array(m.bytes), m.opts, (stage, done, total) => self.postMessage({ id, stage, done, total }))
      self.postMessage({ id, ...r }, [r.bytes.buffer])
    } else if (m.type === 'render') {
      const r = render(mupdf, m)
      self.postMessage({ id, ...r }, [r.png.buffer])
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err), code: err?.code })
  }
}
