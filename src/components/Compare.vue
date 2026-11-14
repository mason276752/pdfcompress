<script setup>
// 壓縮前後對照：同一頁左右並排（窄螢幕上下排），放大時兩邊一起捲動，方便檢查圖片畫質。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { renderPage } from '../pdf/index.js'
import { fmtBytes } from '../util.js'

const props = defineProps({ item: { type: Object, required: true } })
const emit = defineEmits(['error'])

const ZOOMS = [
  { value: 1, label: '整頁' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

const page = ref(0)
const pages = ref(props.item.result.pages || 1)
const zoom = ref(1)
const shots = ref({ a: '', b: '' })
const loading = ref(false)
const panes = { a: ref(null), b: ref(null) }
const paneA = panes.a
const paneB = panes.b

function setShot(which, png) {
  if (shots.value[which]) URL.revokeObjectURL(shots.value[which])
  shots.value[which] = URL.createObjectURL(new Blob([png], { type: 'image/png' }))
}

// 每次重畫發一個序號；翻頁翻得比畫得快時，舊的結果直接丟掉。
let seq = 0
async function draw() {
  const run = ++seq
  loading.value = true
  const it = props.item
  // 依窗格的實際像素寬來畫，放大時再乘上倍率（上限 4000px，太大的 PNG 解碼會卡）。
  const css = paneA.value?.clientWidth || 480
  const width = Math.min(4000, Math.round(css * (window.devicePixelRatio || 1) * zoom.value))
  try {
    const [a, b] = await Promise.all([
      renderPage(`${it.id}:a`, () => it.file.arrayBuffer(), page.value, width, it.password),
      renderPage(`${it.id}:b:${it.run}`, () => it.result.blob.arrayBuffer(), page.value, width, it.password),
    ])
    if (run !== seq) return
    pages.value = b.pages
    setShot('a', a.png)
    setShot('b', b.png)
  } catch (err) {
    if (run === seq) emit('error', `無法預覽：${err.message}`)
  } finally {
    if (run === seq) loading.value = false
  }
}

function go(delta) {
  const next = Math.min(pages.value - 1, Math.max(0, page.value + delta))
  if (next !== page.value) page.value = next
}

// 兩邊一起捲：放大後比對同一塊區域。
let syncing = false
function onScroll(from) {
  if (syncing) return
  const src = panes[from].value
  const dst = panes[from === 'a' ? 'b' : 'a'].value
  if (!src || !dst) return
  syncing = true
  dst.scrollLeft = src.scrollLeft
  dst.scrollTop = src.scrollTop
  requestAnimationFrame(() => { syncing = false })
}

function onKey(e) {
  if (e.target.closest?.('input, textarea, select')) return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1)
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1)
  else return
  e.preventDefault()
}

watch([page, zoom], draw)
onMounted(() => {
  draw()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  seq++
  window.removeEventListener('keydown', onKey)
  for (const url of Object.values(shots.value)) if (url) URL.revokeObjectURL(url)
})

const saved = (it) => Math.min(99, Math.round((1 - it.result.blob.size / it.size) * 100))
</script>

<template>
  <div class="compare">
    <div class="bar">
      <button type="button" class="btn small icon" title="上一頁（←）" :disabled="page === 0" @click="go(-1)"><Icon name="left" /></button>
      <span class="pageno">第 {{ page + 1 }} / {{ pages }} 頁</span>
      <button type="button" class="btn small icon" title="下一頁（→）" :disabled="page >= pages - 1" @click="go(1)"><Icon name="right" /></button>
      <span v-if="loading" class="spinner small" aria-hidden="true"></span>
      <span class="grow"></span>
      <span class="zooms" role="group" aria-label="縮放">
        <button v-for="z in ZOOMS" :key="z.value" type="button" class="btn small" :class="{ on: zoom === z.value }"
                @click="zoom = z.value">{{ z.label }}</button>
      </span>
    </div>
    <div class="sides" :class="{ zoomed: zoom > 1 }">
      <figure>
        <figcaption>原始 · {{ fmtBytes(item.size) }}</figcaption>
        <div ref="paneA" class="pane" @scroll="onScroll('a')">
          <img v-if="shots.a" :src="shots.a" alt="原始的這一頁" :style="{ width: zoom * 100 + '%' }" />
        </div>
      </figure>
      <figure>
        <figcaption>壓縮後 · {{ fmtBytes(item.result.blob.size) }} <b>−{{ saved(item) }}%</b></figcaption>
        <div ref="paneB" class="pane" @scroll="onScroll('b')">
          <img v-if="shots.b" :src="shots.b" alt="壓縮後的這一頁" :style="{ width: zoom * 100 + '%' }" />
        </div>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; }
.pageno { min-width: 6.5em; text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; }
.zooms { display: inline-flex; gap: 4px; }
.spinner.small { width: 12px; height: 12px; }
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 640px) {
  .sides { grid-template-columns: 1fr; }
}
figure { margin: 0; min-width: 0; }
figcaption { margin: 0 2px 6px; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
figcaption b { color: var(--accent); font-weight: 600; }
.pane {
  overflow: auto; max-height: 75vh;
  border: 1px solid var(--line); border-radius: 10px; background: var(--hover);
}
.pane img { display: block; max-width: none; height: auto; background: #fff; }
.sides:not(.zoomed) .pane { max-height: none; overflow: hidden; }
</style>
