<script setup>
defineProps({ name: { type: String, required: true } })
</script>

<script>
// 24×24 線條圖示（與 zipeditor 同一套畫法）。
const PATHS = {
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  send: 'M5 12h13M13 6l6 6-6 6',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1z',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
}
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="PATHS[name]" />
  </svg>
</template>
