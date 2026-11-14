// PDF 壓縮的核心：MuPDF 打開文件，只換掉圖片，其他物件（文字、向量、書籤、連結、表單）原封不動。
//
//   1. 量測：每一頁用自訂 Device 跑一次，記下每張圖實際畫在頁面上的大小，算出它的有效 DPI
//   2. 圖片：超過目標 DPI 的縮小（面積平均）；照片重新編成 JPEG，圖表、截圖這類顏色少的保持無損
//   3. 字型：只留用到的字形（有表單欄位時不做，否則之後在欄位裡打字會缺字）
//   4. 存檔：清掉沒用到的物件、合併重複物件、壓縮所有串流、改用物件串流
//
// 加密的 PDF 解開後照原本的加密方式存回去。
import * as mupdf from 'mupdf'
import { downsample } from './resample.js'

/** 小於這個像素數的圖不值得重編（圖示、項目符號……）。 */
const MIN_PIXELS = 64 * 64
/** 有效 DPI 超過目標的這個倍數才縮小；只超過一點點就縮，畫質損失比省下的空間划不來。 */
const THRESHOLD = 1.25
/** 抽樣到的顏色不超過這麼多種，就當成圖表／截圖：JPEG 會在銳利的邊緣留下雜訊。 */
const GRAPHIC_COLORS = 256

const nameOf = (obj, key) => {
  const v = obj.get(key)
  return v.isName() ? v.asName() : ''
}

function filtersOf(obj) {
  const f = obj.get('Filter')
  if (f.isName()) return [f.asName()]
  const out = []
  if (f.isArray()) for (let i = 0; i < f.length; i++) out.push(f.get(i).asName())
  return out
}

/** 有效 DPI 用的鍵：Device 拿到的 fz_image 對不回 PDF 物件編號，只好用像素尺寸配對。 */
const sizeKey = (w, h) => `${w}x${h}`

/**
 * 每張圖畫在頁面上的最大尺寸（點，1/72 英寸）。尺寸相同的圖取最大的那次，只會縮得比較保守。
 * 也回傳最大的頁面邊長：沒量到的圖（沒畫出來，或只在隱藏圖層裡）當作鋪滿整頁。
 */
function measurePlacements(doc, onPage) {
  const placed = new Map()
  const record = (image, ctm) => {
    const key = sizeKey(image.getWidth(), image.getHeight())
    const w = Math.hypot(ctm[0], ctm[1])
    const h = Math.hypot(ctm[2], ctm[3])
    const prev = placed.get(key)
    if (!prev) placed.set(key, { w, h })
    else {
      prev.w = Math.max(prev.w, w)
      prev.h = Math.max(prev.h, h)
    }
  }
  const device = new mupdf.Device({
    fillImage: (image, ctm) => record(image, ctm),
    fillImageMask: (image, ctm) => record(image, ctm),
    clipImageMask: (image, ctm) => record(image, ctm),
  })
  const pages = doc.countPages()
  let maxSide = 0
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i)
    const [x0, y0, x1, y1] = page.getBounds()
    maxSide = Math.max(maxSide, x1 - x0, y1 - y0)
    page.run(device, mupdf.Matrix.identity)
    page.destroy()
    onPage(i + 1, pages)
  }
  device.close()
  device.destroy()
  return { placed, maxSide }
}

/** 抽樣數顏色：照片隨便都有上千種，圖表、截圖、文字掃成彩色的通常只有幾十種。 */
export function looksLikeGraphic(samples, width, height, n, stride) {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)))
  const seen = new Set()
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const p = y * stride + x * n
      const color = n === 1 ? samples[p] : (samples[p] << 16) | (samples[p + 1] << 8) | samples[p + 2]
      seen.add(color)
      if (seen.size > GRAPHIC_COLORS) return false
    }
  }
  return true
}

/**
 * 目標尺寸：有效 DPI 超過 `dpi` 的 THRESHOLD 倍才縮到 `dpi`，否則維持原尺寸。
 * `placed` 是這張圖畫在頁面上的大小（點）。
 */
export function targetSize(w, h, placed, dpi) {
  const now = Math.min((w * 72) / Math.max(placed.w, 1e-3), (h * 72) / Math.max(placed.h, 1e-3))
  if (now <= dpi * THRESHOLD) return { w, h }
  const scale = dpi / now
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/**
 * @param {Uint8Array} bytes
 * @param {{ dpi: number, quality: number, password?: string }} opts
 * @param {(stage: 'scan'|'images'|'save', done?: number, total?: number) => void} [onProgress]
 * @returns {{ bytes: Uint8Array, pages: number, repaired: boolean, stats: { images: number, changed: number, downsampled: number, failed: number } }}
 */
export function compressPdf(bytes, opts, onProgress = () => {}) {
  let doc
  try {
    doc = new mupdf.PDFDocument(bytes)
  } catch (err) {
    throw Object.assign(new Error('打不開這個 PDF，檔案可能已經損壞'), { code: 'broken', cause: err })
  }
  try {
    if (doc.needsPassword() && !(opts.password && doc.authenticatePassword(opts.password))) {
      throw Object.assign(new Error(opts.password ? '密碼不對' : '這個 PDF 需要密碼才能打開'), { code: 'password' })
    }
    if (!doc.countPages()) throw Object.assign(new Error('找不到任何頁面，檔案可能已經損壞'), { code: 'broken' })
    const { placed, maxSide } = measurePlacements(doc, (done, total) => onProgress('scan', done, total))
    // 截斷、下載不完整的檔案 MuPDF 會盡量修復，但可能少了幾頁或幾張圖，要讓使用者知道。
    const repaired = doc.wasRepaired()

    // 列出所有圖片串流；被別張圖當成 SMask／Mask 的，跟著那張圖一起處理。
    const images = []
    const masks = new Set()
    for (let num = 1, count = doc.countObjects(); num < count; num++) {
      const obj = doc.newIndirect(num)
      if (!obj.isStream() || nameOf(obj, 'Subtype') !== 'Image') continue
      images.push(obj)
      for (const key of ['SMask', 'Mask']) {
        const m = obj.get(key)
        if (m.isIndirect()) masks.add(m.asIndirect())
      }
    }

    const todo = images.filter((obj) => !masks.has(obj.asIndirect()))
    const stats = { images: todo.length, changed: 0, downsampled: 0, failed: 0 }
    todo.forEach((obj, i) => {
      onProgress('images', i, todo.length)
      try {
        const r = recompress(doc, obj, placed, maxSide, opts)
        if (r) stats.changed++
        if (r === 'downsampled') stats.downsampled++
      } catch (err) {
        // 解不開或寫不回去的圖就保留原樣，不要讓一張怪圖拖垮整份文件。
        console.warn(`image ${obj.asIndirect()}:`, err)
        stats.failed++
      }
    })
    onProgress('images', todo.length, todo.length)

    onProgress('save')
    stripPrivateData(doc)
    const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields')
    if (!(fields.isArray() && fields.length)) {
      try {
        doc.subsetFonts()
      } catch (err) {
        console.warn('subsetFonts:', err)
      }
    }
    const out = doc.saveToBuffer('garbage=deduplicate,compress=yes,compress-fonts=yes,compress-images=yes,objstms=yes')
    return { bytes: out.asUint8Array().slice(), pages: doc.countPages(), stats, repaired }
  } finally {
    doc.destroy()
  }
}

/** 重編一張圖；回傳 'downsampled'／'recompressed'，沒動就回傳 null。 */
function recompress(doc, obj, placed, maxSide, { dpi, quality }) {
  if (obj.get('ImageMask').asBoolean()) return null
  if (obj.get('BitsPerComponent').asNumber() === 1) return null // 黑白掃描：CCITT／JBIG2 已經很省，換 JPEG 只會更大更糊
  const filters = filtersOf(obj)
  if (filters.includes('JBIG2Decode') || filters.includes('CCITTFaxDecode')) return null
  if (obj.get('Mask').isArray()) return null // 色鍵遮罩：JPEG 會讓顏色偏掉，就對不上要挖掉的顏色了
  const smask = obj.get('SMask')
  if (smask.isStream() && smask.get('Matte').isArray()) return null // 預乘過的透明圖，少見，不碰

  const w = obj.get('Width').asNumber()
  const h = obj.get('Height').asNumber()
  if (w * h < MIN_PIXELS) return null

  const image = doc.loadImage(obj)
  const type = image.getColorSpace()?.getType()
  if (!['Gray', 'RGB', 'CMYK', 'Indexed', 'Lab'].includes(type)) {
    image.destroy()
    return null // 特別色（Separation／DeviceN）留著
  }
  let pix = image.toPixmap()
  image.destroy()

  const where = placed.get(sizeKey(w, h)) ?? { w: maxSide * Math.min(1, w / h), h: maxSide * Math.min(1, h / w) }
  const size = targetSize(w, h, where, dpi)
  const shrink = size.w < w || size.h < h
  // 一律存成 DeviceGray 或 DeviceRGB：CMYK、Lab、索引色在這裡轉掉（和 Ghostscript 的 /ebook 一樣轉成 RGB）。
  const gray = pix.getColorSpace()?.getType() === 'Gray'
  const cs = gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB
  if (pix.getAlpha() || pix.getColorSpace()?.getType() !== cs.getType()) {
    const converted = pix.convertToColorSpace(cs, false)
    pix.destroy()
    pix = converted
  }
  const n = pix.getNumberOfComponents()
  const graphic = looksLikeGraphic(pix.getPixels(), pix.getWidth(), pix.getHeight(), n, pix.getStride())
  if (graphic && !shrink) {
    pix.destroy()
    return null // 無損的圖表、截圖，又不必縮：原本的壓縮已經是最適合的
  }

  let out = pix
  if (shrink) {
    out = new mupdf.Pixmap(cs, [0, 0, size.w, size.h], false)
    out.getPixels().set(downsample(pix.getPixels(), pix.getWidth(), pix.getHeight(), n, pix.getStride(), size.w, size.h))
    pix.destroy()
  }

  if (graphic) {
    // 縮小後照樣無損：寫入未壓縮的樣本，存檔時 MuPDF 會用 Flate 壓。
    obj.writeStream(new Uint8Array(out.getPixels()))
  } else {
    const jpeg = out.asJPEG(quality)
    const before = obj.readRawStream().getLength()
    if (!shrink && jpeg.length >= before * 0.9) {
      out.destroy()
      return null // 已經壓得夠小（例如本來就是低品質 JPEG），重編只會多損失畫質
    }
    obj.writeRawStream(jpeg)
    obj.put('Filter', doc.newName('DCTDecode'))
  }
  out.destroy()
  obj.delete('DecodeParms')
  obj.delete('Decode') // 解碼時已經套用過了
  obj.put('Width', size.w)
  obj.put('Height', size.h)
  obj.put('BitsPerComponent', 8)
  obj.put('ColorSpace', doc.newName(gray ? 'DeviceGray' : 'DeviceRGB'))

  if (smask.isStream() && shrink) resizeMask(doc, smask, size.w, size.h)
  return shrink ? 'downsampled' : 'recompressed'
}

/** SMask 跟著縮到同樣大小，存成 8 位元灰階（存檔時再 Flate 壓縮）。 */
function resizeMask(doc, ref, dw, dh) {
  const mask = doc.loadImage(ref)
  const pix = mask.toPixmap()
  mask.destroy()
  const n = pix.getNumberOfComponents()
  const data = downsample(pix.getPixels(), pix.getWidth(), pix.getHeight(), n, pix.getStride(), dw, dh)
  pix.destroy()
  const alpha = n === 1 ? data : data.filter((_, i) => i % n === 0)
  ref.writeStream(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.length))
  ref.delete('DecodeParms')
  ref.delete('Decode')
  ref.put('Width', dw)
  ref.put('Height', dh)
  ref.put('BitsPerComponent', 8)
  ref.put('ColorSpace', doc.newName('DeviceGray'))
}

/** 清掉不影響顯示的大塊資料：頁面縮圖、Illustrator／InDesign 留下的原始編輯資料。 */
function stripPrivateData(doc) {
  doc.getTrailer().get('Root').delete('PieceInfo')
  for (let i = 0, n = doc.countPages(); i < n; i++) {
    const page = doc.findPage(i)
    page.delete('Thumb')
    page.delete('PieceInfo')
  }
}
