<script setup>
// PDF 壓縮：MuPDF（WASM）在瀏覽器裡把 PDF 裡的圖片降到合理的解析度、重新壓縮，文字和向量不動。
//   * 壓縮：在 Web Worker 裡跑，一次一個檔（見 pdf/）
//   * 對照：壓縮前後同一頁並排，可以放大檢查畫質（見 components/Compare.vue）
//   * 串接：ZIP 編輯器可以把 PDF 傳過來，結果打包成 ZIP 傳回去（見 bridge.js）
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from './components/Icon.vue'
import Compare from './components/Compare.vue'
import { bridgeSupported, listen, sendToEditor } from './bridge.js'
import { makeZip } from './zip.js'
import { fmtBytes, saveBlob, timeStamp, uniqueName } from './util.js'
import { cancelCompress, compress, forget } from './pdf/index.js'

// ---------- toast ----------
const toastMsg = ref('')
let toastTimer
function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 3600)
}

// ---------- 設定 ----------
const PRESETS = [
  { id: 'light', label: '輕度', dpi: 200, quality: 85, hint: '圖片幾乎看不出差別，適合列印' },
  { id: 'medium', label: '建議', dpi: 150, quality: 75, hint: '螢幕上看很清楚，檔案小很多' },
  { id: 'strong', label: '強力', dpi: 96, quality: 60, hint: '檔案最小，適合寄信或上傳有大小限制時' },
]
const DPIS = [72, 96, 120, 150, 200, 300]
const STORE_KEY = 'pdfcompress-settings'

const settings = reactive({ dpi: 150, quality: 75 })
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY))
  if (DPIS.includes(saved?.dpi) && saved.quality >= 30 && saved.quality <= 95) Object.assign(settings, saved)
} catch {}
watch(settings, () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)) } catch {}
})
const preset = computed(() => PRESETS.find((p) => p.dpi === settings.dpi && p.quality === settings.quality) || null)
const usePreset = (p) => Object.assign(settings, { dpi: p.dpi, quality: p.quality })
const sameOpts = (o) => o.dpi === settings.dpi && o.quality === settings.quality

// ---------- 檔案 ----------
// File、Blob 一律 markRaw：交給 Vue 代理的話，原生方法會因為 `this` 是 Proxy 而出錯。
// { id, file, name, size, status, stage, progress, error, password, result, run }
// status: 'queued' | 'running' | 'done' | 'error' | 'locked'
// result: { blob, url, pages, stats, repaired, opts, kept }；kept：壓了反而更大，保留原檔
const items = ref([])
const selectedId = ref(null)
const selected = computed(() => items.value.find((i) => i.id === selectedId.value) || null)
const doneItems = computed(() => items.value.filter((i) => i.status === 'done'))
const staleItems = computed(() => doneItems.value.filter((i) => !sameOpts(i.result.opts)))
const fileInput = ref(null)

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)

function addFiles(list, from) {
  const files = [...list]
  const pdfs = files.filter(isPdf)
  if (!pdfs.length) {
    if (files.length) toast('沒有可以處理的 PDF')
    return
  }
  const added = pdfs.map((f) => ({
    id: crypto.randomUUID(),
    file: markRaw(f),
    name: f.name || 'document.pdf',
    size: f.size,
    status: 'queued',
    stage: '',
    progress: 0,
    error: '',
    password: '',
    result: null,
    run: 0,
  }))
  items.value.push(...added)
  if (!selected.value) selectedId.value = added[0].id
  const skipped = files.length - pdfs.length
  const who = from === 'zipeditor' ? '從 ZIP 編輯器收到' : '已加入'
  toast(`${who} ${pdfs.length} 個 PDF${skipped ? `（略過 ${skipped} 個不是 PDF 的）` : ''}`)
  pump()
}

function dropResult(item) {
  if (item.result) URL.revokeObjectURL(item.result.url)
  item.result = null
  forget(`${item.id}:b:`)
}

function removeItem(item) {
  if (item.status === 'running') cancelCompress() // 讓 pump 裡那個以「已取消」結束
  dropResult(item)
  forget(`${item.id}:`)
  const i = items.value.indexOf(item)
  items.value.splice(i, 1)
  if (selectedId.value === item.id) selectedId.value = items.value[Math.min(i, items.value.length - 1)]?.id ?? null
}

function clearAll() {
  for (const item of [...items.value]) removeItem(item)
}

// ---------- 依序壓縮 ----------
let pumping = false
async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const item = items.value.find((i) => i.status === 'queued')
      if (!item) break
      await process(item)
    }
  } finally {
    pumping = false
  }
}

// 每次開始處理一個檔就發一個序號；取消（移除）之後才回來的結果，序號對不上就作廢。
let runSeq = 0

async function process(item) {
  const run = ++runSeq
  item.run = run
  item.status = 'running'
  item.stage = ''
  item.progress = 0
  item.error = ''
  const opts = { dpi: settings.dpi, quality: settings.quality }
  try {
    const bytes = await item.file.arrayBuffer()
    const r = await compress(bytes, { ...opts, password: item.password || undefined }, (stage, done, total) => {
      if (item.run !== run) return
      item.stage = stage
      // 分析頁面約佔 15%、處理圖片 75%、存檔 10%
      item.progress = stage === 'scan' ? (0.15 * done) / total
        : stage === 'images' ? 0.15 + (0.75 * done) / Math.max(total, 1)
          : stage === 'save' ? 0.92 : 0
    })
    if (item.run !== run || !items.value.includes(item)) return
    // 已經很精簡的檔案，重存一次反而可能變大：那就保留原檔。
    const kept = r.bytes.length >= item.size
    const blob = kept ? item.file : new Blob([r.bytes], { type: 'application/pdf' })
    dropResult(item)
    item.result = { blob: markRaw(blob), url: URL.createObjectURL(blob), pages: r.pages, stats: r.stats, repaired: r.repaired, opts, kept }
    item.status = 'done'
  } catch (err) {
    if (item.run !== run || !items.value.includes(item)) return
    if (err.code === 'password') {
      item.status = 'locked'
      item.error = item.password ? '密碼不對，請再試一次' : '這個 PDF 有密碼保護'
      return
    }
    item.status = 'error'
    item.error = String(err.message || err)
    if (/memory|allocation|out of bounds/i.test(item.error)) item.error = '記憶體不夠，檔案可能太大'
  }
}

function retry(item) {
  item.status = 'queued'
  item.error = ''
  pump()
}

function unlock(item, password) {
  if (!password) return
  item.password = password
  retry(item)
}

function recompressStale() {
  for (const item of staleItems.value) {
    dropResult(item)
    item.status = 'queued'
  }
  pump()
}

// ---------- 輸出 ----------
const outName = (item) => `${item.name.replace(/\.pdf$/i, '') || 'document'}-壓縮.pdf`

function downloadOne(item) {
  saveBlob(item.result.blob, outName(item))
}

function zipList() {
  const taken = new Set()
  return doneItems.value.map((i) => ({ name: uniqueName(outName(i), taken), blob: i.result.blob }))
}
const zipName = () => `pdfcompress-${timeStamp()}.zip`

async function downloadAll() {
  saveBlob(await makeZip(zipList()), zipName())
}

const sending = ref(false)
async function sendAll() {
  if (sending.value || !doneItems.value.length) return
  sending.value = true
  // 同步呼叫：ZIP 編輯器沒開的話要在這次點擊裡開新分頁。
  const res = await sendToEditor(async () => new File([await makeZip(zipList())], zipName(), { type: 'application/zip' }))
  sending.value = false
  if (res === 'sent') toast(`已把 ${doneItems.value.length} 個壓縮好的 PDF 傳到 ZIP 編輯器`)
  else if (res === 'blocked') toast('瀏覽器擋下了新分頁，請先開啟 ZIP 編輯器再傳送')
  else toast('ZIP 編輯器沒有回應，請再試一次')
}

const totalBefore = computed(() => doneItems.value.reduce((s, i) => s + i.size, 0))
const totalAfter = computed(() => doneItems.value.reduce((s, i) => s + i.result.blob.size, 0))
// 上限 99%：省了 99.6% 也不該顯示成「−100%」，看起來像檔案不見了。
const savedPct = (before, after) => Math.min(99, Math.max(0, Math.round((1 - after / before) * 100)))

const STAGES = { load: '載入 PDF 引擎…', scan: '分析頁面…', images: '處理圖片…', save: '存檔中…' }
const statusText = (i) =>
  i.status === 'queued' ? '等待中'
    : i.status === 'running' ? (STAGES[i.stage] || '準備中…')
      : i.status === 'done'
        ? (i.result.kept ? `${fmtBytes(i.size)} · 已經很精簡，保留原檔` : `${fmtBytes(i.size)} → ${fmtBytes(i.result.blob.size)}`)
        : i.error

function statsText(item) {
  const { stats, pages, kept, repaired } = item.result
  const warn = repaired ? '這個檔案有損壞，已經盡量修復，請確認每一頁都完整。' : ''
  if (kept) return `共 ${pages} 頁。重新壓縮後沒有變小，下載的會是原檔。${warn}`
  if (!stats.changed) return `共 ${pages} 頁。圖片都已經夠精簡，只整理了文件結構和字型。${warn}`
  const parts = [`共 ${pages} 頁，重新壓縮了 ${stats.changed} 張圖`]
  if (stats.downsampled) parts.push(`其中 ${stats.downsampled} 張降到 ${item.result.opts.dpi} DPI`)
  if (stats.failed) parts.push(`${stats.failed} 張解不開，保留原樣`)
  return parts.join('，') + '。' + warn
}

// ---------- 輸入：選檔、拖放、貼上 ----------
function pick() {
  fileInput.value?.click()
}
function onPick(e) {
  addFiles(e.target.files || [])
  e.target.value = ''
}

function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])]
  if (!files.some(isPdf)) return
  e.preventDefault()
  addFiles(files)
}

const dragging = ref(false)
let dragDepth = 0
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
function onDragEnter(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
}
function onDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e) {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0
    dragging.value = false
  }
}
function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  addFiles(e.dataTransfer.files)
}

function onBeforeUnload(e) {
  if (items.value.some((i) => i.status === 'done' || i.status === 'running')) {
    e.preventDefault()
    e.returnValue = ''
  }
}

let stopListening = () => {}
onMounted(() => {
  window.addEventListener('paste', onPaste)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('beforeunload', onBeforeUnload)
  stopListening = listen((files, from) => addFiles(files, from || 'zipeditor'))
})
onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('beforeunload', onBeforeUnload)
  stopListening()
})
</script>

<template>
  <div class="app" :class="{ dragging }">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#be123c"/><path d="M10 5h8.5L24 10.5V25a2 2 0 01-2 2H10a2 2 0 01-2-2V7a2 2 0 012-2z" fill="#fff"/><path d="M12.5 12.5l3.5 3 3.5-3M12.5 23.5l3.5-3 3.5 3" fill="none" stroke="#be123c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div>
          <h1>PDF 壓縮</h1>
          <p v-if="!items.length">把 PDF 裡的圖片壓小，文字維持清晰可搜尋。檔案不會離開你的裝置。</p>
        </div>
      </div>
    </header>

    <section class="panel section settings">
      <h2>壓縮程度</h2>
      <div class="presets" role="radiogroup" aria-label="壓縮程度">
        <button v-for="p in PRESETS" :key="p.id" type="button" role="radio" class="preset"
                :class="{ on: preset?.id === p.id }" :aria-checked="preset?.id === p.id" @click="usePreset(p)">
          <strong>{{ p.label }}</strong>
          <span>{{ p.hint }}</span>
          <small>{{ p.dpi }} DPI · 品質 {{ p.quality }}</small>
        </button>
      </div>
      <details class="custom" :open="!preset">
        <summary>自訂{{ preset ? '' : `：${settings.dpi} DPI · 品質 ${settings.quality}` }}</summary>
        <div class="custom-row">
          <label>
            圖片解析度
            <select v-model.number="settings.dpi">
              <option v-for="d in DPIS" :key="d" :value="d">{{ d }} DPI</option>
            </select>
          </label>
          <label class="grow">
            JPEG 品質 <b>{{ settings.quality }}</b>
            <input v-model.number="settings.quality" type="range" min="30" max="95" step="5" />
          </label>
        </div>
        <p class="note">解析度是圖片印在頁面上的實際密度：一張照片只佔半頁寬，就只需要半頁寬的像素。超過設定的才會縮小；顏色少的圖表、截圖維持無損，黑白掃描不重新壓縮。</p>
      </details>
      <div v-if="staleItems.length" class="banner">
        <span class="grow">設定改了，{{ staleItems.length }} 個檔案還是用舊的設定壓縮的</span>
        <button type="button" class="btn small primary" @click="recompressStale"><Icon name="refresh" />用新設定重新壓縮</button>
      </div>
    </section>

    <template v-if="!items.length">
      <section class="start panel">
        <Icon name="file" class="hero" />
        <strong>把 PDF 拖進來、貼上，或選擇檔案</strong>
        <span>一次可以放很多個，放進來就開始壓縮</span>
        <div class="start-btns">
          <button type="button" class="btn primary" @click="pick"><Icon name="upload" />選擇 PDF</button>
        </div>
      </section>

      <section class="about panel">
        <h2>可以做什麼</h2>
        <ul>
          <li><strong>壓圖片、不壓文字</strong>：照片降到設定的解析度、重新編成 JPEG；文字、向量圖形、書籤、連結、表單原封不動，壓縮後一樣可以搜尋、複製。</li>
          <li><strong>看實際大小決定解析度</strong>：同一張照片印得越小，需要的像素越少，不會一律縮成同樣大小。</li>
          <li><strong>前後對照</strong>：壓好後可以並排比較每一頁，放大到 4 倍檢查畫質。</li>
          <li><strong>其他瘦身</strong>：只留用到的字形、刪掉重複和沒用到的物件、移除頁面縮圖和 Illustrator 之類的編輯資料。</li>
          <li><strong>有密碼的 PDF</strong>：輸入密碼後壓縮，存回去時照樣加密。</li>
          <li><strong>串接 ZIP 編輯器</strong>：在 <a href="../zipeditor/">ZIP 編輯器</a>勾選 PDF 就能傳過來，壓好後再按「傳到 ZIP 編輯器」放回去。</li>
          <li><strong>不上傳</strong>：用 <a href="https://mupdf.com/">MuPDF</a> 編成的 WebAssembly 在瀏覽器裡執行（第一次載入約 5MB）。掃描檔、照片多的簡報最有效；純文字的 PDF 本來就小，能省的有限。</li>
        </ul>
      </section>
    </template>

    <template v-else>
      <section class="panel section">
        <h2>
          檔案 <span class="count">{{ items.length }}</span>
          <span class="grow"></span>
          <button type="button" class="btn small" @click="pick"><Icon name="plus" />加入 PDF</button>
          <button type="button" class="btn small danger" @click="clearAll"><Icon name="trash" />全部清除</button>
        </h2>
        <ul class="rows">
          <li v-for="item in items" :key="item.id" :class="{ active: item.id === selectedId, [item.status]: true }">
            <button type="button" class="pick" :title="item.name" @click="selectedId = item.id">
              <Icon :name="item.status === 'locked' ? 'lock' : 'file'" class="kind" />
              <span class="meta">
                <b>{{ item.name }}</b>
                <span class="status">
                  <span v-if="item.status === 'running' || item.status === 'queued'" class="spinner small" aria-hidden="true"></span>
                  {{ statusText(item) }}
                </span>
              </span>
              <span v-if="item.status === 'done' && !item.result.kept" class="saved">−{{ savedPct(item.size, item.result.blob.size) }}%</span>
            </button>
            <span v-if="item.status === 'running'" class="bar"><span :style="{ width: item.progress * 100 + '%' }"></span></span>
            <form v-if="item.status === 'locked'" class="unlock" @submit.prevent="unlock(item, $event.target.elements.pw.value)">
              <input name="pw" type="password" placeholder="輸入密碼" autocomplete="off" aria-label="PDF 密碼" />
              <button type="submit" class="btn small primary">解鎖</button>
            </form>
            <div class="row-btns">
              <button v-if="item.status === 'done'" type="button" class="btn small icon" title="下載" @click="downloadOne(item)"><Icon name="download" /></button>
              <button v-if="item.status === 'error'" type="button" class="btn small icon" title="重試" @click="retry(item)"><Icon name="refresh" /></button>
              <button type="button" class="btn small icon danger" title="移除" @click="removeItem(item)"><Icon name="x" /></button>
            </div>
          </li>
        </ul>
        <div class="actions">
          <span class="grow muted">
            {{ doneItems.length }} / {{ items.length }} 個完成<template v-if="doneItems.length">
              · 共 {{ fmtBytes(totalBefore) }} → {{ fmtBytes(totalAfter) }}（−{{ savedPct(totalBefore, totalAfter) }}%）</template>
          </span>
          <button v-if="doneItems.length > 1" type="button" class="btn" @click="downloadAll"><Icon name="download" />打包下載</button>
          <button v-if="bridgeSupported" type="button" class="btn" :class="{ primary: doneItems.length > 1 }" :disabled="sending || !doneItems.length" @click="sendAll">
            <Icon name="send" />傳到 ZIP 編輯器
          </button>
          <button v-if="doneItems.length === 1" type="button" class="btn primary" @click="downloadOne(doneItems[0])"><Icon name="download" />下載</button>
        </div>
      </section>

      <section v-if="selected" class="panel section">
        <h2 class="title">
          <span class="grow">{{ selected.name }}</span>
          <button v-if="selected.status === 'done'" type="button" class="btn small primary" @click="downloadOne(selected)">
            <Icon name="download" />下載 PDF
          </button>
        </h2>
        <template v-if="selected.status === 'done'">
          <p class="muted summary">{{ statsText(selected) }}</p>
          <Compare v-if="!selected.result.kept" :key="`${selected.id}:${selected.run}`" :item="selected" @error="toast" />
        </template>
        <div v-else-if="selected.status === 'error' || selected.status === 'locked'" class="banner error">{{ selected.error }}</div>
        <div v-else class="banner">
          <span class="spinner" aria-hidden="true"></span>
          <span>{{ statusText(selected) }}</span>
          <span v-if="selected.stage === 'load'" class="muted">（第一次使用要下載約 5MB 的引擎，之後從快取讀）</span>
        </div>
      </section>
    </template>

    <footer>
      PDF 壓縮 · 所有運算都在瀏覽器內完成 ·
      引擎 <a href="https://mupdf.com/">MuPDF</a>（AGPL）·
      <a href="../zipeditor/">ZIP 編輯器</a> ·
      <a href="../">更多工具</a> ·
      <a href="https://github.com/mason276752/pdfcompress">GitHub 原始碼</a>
    </footer>

    <div class="toast" :class="{ show: toastMsg }" role="status" aria-live="polite">
      <span>{{ toastMsg }}</span>
    </div>

    <input ref="fileInput" type="file" accept="application/pdf,.pdf" multiple hidden @change="onPick" />
  </div>
</template>

<style scoped>
.settings { margin-top: 0; }
.presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
@media (max-width: 640px) {
  .presets { grid-template-columns: 1fr; }
}
.preset {
  appearance: none; display: grid; gap: 2px; padding: 10px 12px; text-align: left;
  border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--text);
  font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: border-color .15s, background-color .15s;
}
.preset:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.preset:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.preset.on { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent); }
.preset strong { font-size: 15px; }
.preset.on strong { color: var(--accent); }
.preset span { color: var(--muted); font-size: 13px; }
.preset small { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.custom { margin-top: 10px; }
.custom summary { width: fit-content; color: var(--muted); font-size: 13px; cursor: pointer; }
.custom-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; margin-top: 10px; }
.custom-row label { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.custom-row label b { min-width: 2ch; font-variant-numeric: tabular-nums; }
.custom-row input[type="range"] { flex: 1; min-width: 120px; max-width: 280px; }
.note { margin: 10px 0 0; color: var(--muted); font-size: 13px; }

.rows { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.rows li {
  position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 6px 8px 6px 4px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
}
.rows li.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.pick {
  appearance: none; display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; padding: 4px 6px;
  border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.pick:focus-visible { outline: 2px solid var(--accent); }
.kind { width: 22px; height: 22px; color: var(--accent); }
.meta { display: grid; flex: 1; min-width: 0; }
.meta b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.error .status, .locked .status { color: var(--danger); }
.saved {
  flex: none; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
  font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: color-mix(in srgb, var(--accent) 15%, transparent); }
.bar span { display: block; height: 100%; background: var(--accent); transition: width .2s; }
.unlock { display: flex; gap: 6px; }
.unlock input {
  width: 150px; min-height: 32px; padding: 4px 8px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; font-size: 13px;
}
.spinner.small { width: 11px; height: 11px; border-width: 2px; }
.row-btns { display: flex; justify-content: flex-end; gap: 6px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.actions .grow { min-width: min(100%, 18em); }
.muted { color: var(--muted); font-size: 13px; }
.summary { margin: -4px 0 12px; }
.title { overflow-wrap: anywhere; }
</style>
