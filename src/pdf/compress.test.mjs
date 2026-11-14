import { test } from 'vitest'
import assert from 'node:assert/strict'
import * as mupdf from 'mupdf'
import { compressPdf, looksLikeGraphic, targetSize } from './compress.js'

const A4 = [0, 0, 595, 842]
const OPTS = { dpi: 150, quality: 75 }

/** 像照片的測試圖：平滑漸層加一點雜訊（雜訊用固定種子，結果才穩定）。 */
function photo(w, h, n = 3, seed = 1) {
  const cs = { 1: mupdf.ColorSpace.DeviceGray, 3: mupdf.ColorSpace.DeviceRGB, 4: mupdf.ColorSpace.DeviceCMYK }[n]
  const pix = new mupdf.Pixmap(cs, [0, 0, w, h], false)
  const px = pix.getPixels()
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < n; c++)
        px[(y * w + x) * n + c] = 128 + 90 * Math.sin(x / (40 + 30 * c) + y / 77 + c) * Math.cos(y / (55 + 9 * c)) + (rnd() - 0.5) * 24
  return pix
}

/** 一頁一份內容；`xobjects` 會放進頁面資源。 */
function makePdf(pages) {
  const doc = new mupdf.PDFDocument()
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  for (const { xobjects = {}, content } of pages(doc)) {
    const res = doc.addObject({ XObject: xobjects, Font: { F1: font } })
    doc.insertPage(-1, doc.addPage(A4, 0, res, content))
  }
  return doc
}
const bytesOf = (doc, opts = 'compress=yes') => doc.saveToBuffer(opts).asUint8Array().slice()

/** 兩份 PDF 第 `page` 頁的平均像素差（0–255）。 */
function renderDiff(a, b, page = 0, zoom = 0.5) {
  const render = (bytes) =>
    new mupdf.PDFDocument(bytes).loadPage(page).toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false).getPixels().slice()
  const pa = render(a)
  const pb = render(b)
  assert.equal(pa.length, pb.length)
  let sum = 0
  for (let i = 0; i < pa.length; i++) sum += Math.abs(pa[i] - pb[i])
  return sum / pa.length
}

/** 文件裡所有圖片串流的字典。 */
function imagesOf(bytes) {
  const doc = new mupdf.PDFDocument(bytes)
  const out = []
  for (let num = 1; num < doc.countObjects(); num++) {
    const obj = doc.newIndirect(num)
    if (obj.isStream() && obj.get('Subtype').asName() === 'Image') {
      out.push({
        width: obj.get('Width').asNumber(),
        height: obj.get('Height').asNumber(),
        filter: obj.get('Filter').isName() ? obj.get('Filter').asName() : '',
        raw: obj.readRawStream().asUint8Array().slice(),
      })
    }
  }
  return out
}

test('整頁的 300 DPI 掃描縮到 150 DPI，畫面幾乎不變', () => {
  const src = bytesOf(makePdf((doc) => [
    { xobjects: { Im0: doc.addImage(new mupdf.Image(photo(2480, 3508))) }, content: 'q 595 0 0 842 0 0 cm /Im0 Do Q' },
  ]))
  const { bytes, pages, stats } = compressPdf(src, OPTS)
  assert.equal(pages, 1)
  assert.equal(stats.downsampled, 1)
  const [img] = imagesOf(bytes)
  assert.equal(img.filter, 'DCTDecode')
  assert.ok(Math.abs(img.width - 1240) <= 1 && Math.abs(img.height - 1754) <= 1, `${img.width}×${img.height}`)
  assert.ok(bytes.length < src.length / 10, `${src.length} → ${bytes.length}`)
  assert.ok(renderDiff(src, bytes) < 4)
})

test('有效 DPI 看的是印在頁面上的大小，不是像素數', () => {
  // 3000×2000 印成 3×2 英寸（1000 DPI）→ 450×300；同樣的圖鋪滿整頁寬（約 363 DPI）→ 約 1240 寬
  const jpeg = () => new mupdf.Image(photo(3000, 2000, 3, 7).asJPEG(95))
  const small = compressPdf(bytesOf(makePdf((doc) => [
    { xobjects: { Im0: doc.addImage(jpeg()) }, content: 'q 216 0 0 144 100 500 cm /Im0 Do Q' },
  ])), OPTS)
  assert.deepEqual(imagesOf(small.bytes).map((i) => [i.width, i.height]), [[450, 300]])

  const wide = compressPdf(bytesOf(makePdf((doc) => [
    { xobjects: { Im0: doc.addImage(jpeg()) }, content: 'q 595 0 0 397 0 200 cm /Im0 Do Q' },
  ])), OPTS)
  const [img] = imagesOf(wide.bytes)
  assert.ok(Math.abs(img.width - 1240) <= 2, String(img.width))
})

test('透明圖的 SMask 跟著縮，CMYK 轉成 RGB，畫面一致', () => {
  const rgba = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1200, 1200], true)
  const color = photo(1200, 1200, 3, 3).getPixels()
  const px = rgba.getPixels()
  for (let i = 0; i < 1200 * 1200; i++) {
    const a = Math.hypot((i % 1200) - 600, Math.floor(i / 1200) - 600) < 520 ? 255 : 0
    for (let c = 0; c < 3; c++) px[i * 4 + c] = (color[i * 3 + c] * a) / 255 // Pixmap 的 alpha 是預乘的
    px[i * 4 + 3] = a
  }
  const src = bytesOf(makePdf((doc) => [
    { xobjects: { Im0: doc.addImage(new mupdf.Image(rgba)) }, content: '0 0 1 rg 0 0 595 842 re f q 288 0 0 288 50 450 cm /Im0 Do Q' },
    { xobjects: { Im0: doc.addImage(new mupdf.Image(photo(2400, 1600, 4, 9).asJPEG(92))) }, content: 'q 432 0 0 288 80 300 cm /Im0 Do Q' },
  ]))
  const { bytes, stats } = compressPdf(src, OPTS)
  assert.equal(stats.downsampled, 2)
  const sizes = imagesOf(bytes).map((i) => `${i.width}x${i.height}`).sort()
  assert.deepEqual(sizes, ['600x600', '600x600', '900x600'], '圖、它的 SMask、CMYK 那張')
  assert.ok(renderDiff(src, bytes, 0) < 3)
  assert.ok(renderDiff(src, bytes, 1) < 3)
})

/** 用原始字典加一張圖（測 Indexed、Decode 這些 addImage 不會產生的寫法）。 */
function rawImage(doc, dict, samples) {
  return doc.addStream(samples, { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8, ...dict })
}

test('索引色、反相（Decode [1 0]）的圖解碼後重編，顏色不變', () => {
  const w = 1600, h = 1200
  const palette = new Uint8Array(256 * 3).map((_, i) => (i * 37) % 256)
  const indexed = new Uint8Array(photo(w, h, 1, 4).getPixels())
  const gray = new Uint8Array(photo(w, h, 1, 5).getPixels())
  const src = bytesOf(makePdf((doc) => [
    {
      xobjects: {
        Im0: rawImage(doc, { Width: w, Height: h, ColorSpace: ['Indexed', 'DeviceRGB', 255, doc.newByteString(palette)] }, indexed),
        Im1: rawImage(doc, { Width: w, Height: h, ColorSpace: 'DeviceGray', Decode: [1, 0] }, gray),
      },
      content: 'q 288 0 0 216 40 500 cm /Im0 Do Q q 288 0 0 216 300 100 cm /Im1 Do Q',
    },
  ]))
  const { bytes, stats } = compressPdf(src, OPTS)
  assert.equal(stats.changed, 2)
  assert.ok(imagesOf(bytes).every((i) => i.width === 600), '4 英寸 × 150 DPI')
  assert.ok(renderDiff(src, bytes) < 4)
})

test('圖表、截圖這類顏色少的圖：不必縮就原封不動，要縮也維持無損', () => {
  const chart = (w, h) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
    const px = pix.getPixels()
    for (let i = 0; i < w * h; i++) {
      const bar = Math.floor((i % w) / (w / 8))
      const on = Math.floor(i / w) > h * (1 - (bar + 1) / 9)
      px.set(on ? [30 * bar, 100, 200 - 20 * bar] : [255, 255, 255], i * 3)
    }
    return pix
  }
  const src = bytesOf(makePdf((doc) => [
    { xobjects: { Im0: doc.addImage(new mupdf.Image(chart(600, 400))) }, content: 'q 288 0 0 192 40 500 cm /Im0 Do Q' },
    { xobjects: { Im0: doc.addImage(new mupdf.Image(chart(2400, 1600))) }, content: 'q 288 0 0 192 40 500 cm /Im0 Do Q' },
  ]))
  const before = imagesOf(src)
  const { bytes } = compressPdf(src, OPTS)
  const after = imagesOf(bytes)
  const kept = after.find((i) => i.width === 600 && i.height === 400)
  assert.ok(kept, '600×400 的那張沒縮')
  assert.deepEqual(kept.raw, before.find((i) => i.width === 600).raw, '而且位元組完全相同')
  assert.ok(after.some((i) => i.width === 600 && i.height === 400 && i !== kept), '2400×1600 縮成 600×400')
  assert.ok(after.every((i) => i.filter !== 'DCTDecode'))
})

test('黑白（1 位元）的圖不碰', () => {
  const w = 2480, h = 3508
  const bits = new Uint8Array(Math.ceil(w / 8) * h).map((_, i) => (i % 7 === 0 ? 0xf0 : 0))
  const src = bytesOf(makePdf((doc) => [
    { xobjects: { Im0: doc.addStream(bits, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 1 }) }, content: 'q 595 0 0 842 0 0 cm /Im0 Do Q' },
  ]))
  const { bytes, stats } = compressPdf(src, OPTS)
  assert.equal(stats.changed, 0)
  assert.deepEqual(imagesOf(bytes).map((i) => [i.width, i.height]), [[w, h]])
})

test('文字、連結、書籤都還在', () => {
  const doc = makePdf((d) => [
    { xobjects: { Im0: d.addImage(new mupdf.Image(photo(2000, 1500))) }, content: 'q 300 0 0 225 100 400 cm /Im0 Do Q BT /F1 18 Tf 72 72 Td (Hello compressed world) Tj ET' },
    { content: 'BT /F1 18 Tf 72 720 Td (Second page) Tj ET' },
  ])
  doc.loadPage(0).createLink([72, 60, 300, 90], 'https://example.com/')
  doc.outlineIterator().insert({ title: '第二頁', uri: '#page=2', open: true })
  const { bytes } = compressPdf(bytesOf(doc), OPTS)

  const out = new mupdf.PDFDocument(bytes)
  assert.match(out.loadPage(0).toStructuredText().asText(), /Hello compressed world/)
  assert.deepEqual(out.loadPage(0).getLinks().map((l) => l.getURI()), ['https://example.com/'])
  assert.deepEqual(out.loadOutline().map((o) => o.title), ['第二頁'])
})

test('加密的 PDF 要密碼；解開後照原本的方式加密存回去', () => {
  const src = bytesOf(
    makePdf((doc) => [{ xobjects: { Im0: doc.addImage(new mupdf.Image(photo(2480, 3508))) }, content: 'q 595 0 0 842 0 0 cm /Im0 Do Q' }]),
    'compress=yes,encrypt=aes-256,user-password=secret,owner-password=owner',
  )
  assert.throws(() => compressPdf(src, OPTS), (e) => e.code === 'password')
  assert.throws(() => compressPdf(src, { ...OPTS, password: 'nope' }), (e) => e.code === 'password' && /不對/.test(e.message))

  const { bytes } = compressPdf(src, { ...OPTS, password: 'secret' })
  assert.ok(bytes.length < src.length / 5)
  const out = new mupdf.PDFDocument(bytes)
  assert.ok(out.needsPassword(), '還是要密碼')
  assert.ok(out.authenticatePassword('secret'))
})

test('looksLikeGraphic：照片顏色多、圖表顏色少', () => {
  const p = photo(300, 200)
  assert.equal(looksLikeGraphic(p.getPixels(), 300, 200, 3, p.getStride()), false)
  const flat = new Uint8Array(300 * 200 * 3).map((_, i) => (Math.floor(i / 900) % 2 ? 255 : 0))
  assert.equal(looksLikeGraphic(flat, 300, 200, 3, 900), true)
})

test('targetSize：差一點點不縮，超過門檻才縮到目標 DPI', () => {
  const inch = { w: 72, h: 72 } // 印成 1×1 英寸
  assert.deepEqual(targetSize(180, 180, inch, 150), { w: 180, h: 180 }) // 180 DPI < 150×1.25
  assert.deepEqual(targetSize(600, 600, inch, 150), { w: 150, h: 150 })
  assert.deepEqual(targetSize(600, 300, { w: 72, h: 72 }, 150), { w: 300, h: 150 }, '拉長的圖照較小的那個方向算')
})

test('截斷的檔案：找不到頁面就報錯，修得回來的要標記 repaired', () => {
  const src = bytesOf(makePdf((doc) => [
    { content: 'BT /F1 18 Tf 72 720 Td (One) Tj ET' },
    { content: 'BT /F1 18 Tf 72 720 Td (Two) Tj ET' },
  ]), 'compress=no')
  assert.equal(compressPdf(src, OPTS).repaired, false)
  assert.throws(() => compressPdf(src.slice(0, 200), OPTS), (e) => e.code === 'broken')
  // 砍掉結尾的 xref 與 trailer：頁面物件都還在，MuPDF 掃描整個檔案重建
  const cut = src.slice(0, new TextDecoder().decode(src).lastIndexOf('xref'))
  const r = compressPdf(cut, OPTS)
  assert.equal(r.repaired, true)
  assert.equal(r.pages, 2)
})
