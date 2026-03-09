<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useStatusStore } from '@/stores/status'

const statusStore = useStatusStore()
const { logs } = storeToRefs(statusStore)

function formatTime(input: any) {
  const raw = String(input || '').trim()
  if (raw)
    return raw
  return '--'
}

function getTypeText(result: string) {
  if (result === 'weed')
    return '放草'
  if (result === 'insect')
    return '放虫'
  if (result === 'steal')
    return '偷菜'
  return '访客'
}

function getTypeClass(result: string) {
  if (result === 'weed')
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (result === 'insect')
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  if (result === 'steal')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
}

const visitorLogs = computed(() => {
  const src = Array.isArray(logs.value) ? logs.value : []
  return src
    .filter((entry: any) => String(entry?.meta?.event || '') === 'visitor')
    .slice(-80)
    .reverse()
})

const summary = computed(() => {
  const list = visitorLogs.value
  let weed = 0
  let insect = 0
  let steal = 0
  for (const entry of list) {
    const result = String(entry?.meta?.result || '')
    if (result === 'weed')
      weed++
    else if (result === 'insect')
      insect++
    else if (result === 'steal')
      steal++
  }
  return { total: list.length, weed, insect, steal }
})
</script>

<template>
  <div class="space-y-4">
    <div class="glass-panel border border-white/20 rounded-lg p-4 shadow-sm dark:border-white/10">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="glass-text-main flex items-center gap-2 text-base font-semibold">
          <div class="i-carbon-user-multiple text-lg" />
          <span>访客面板</span>
        </div>
        <span class="rounded-full bg-blue-100 px-2.5 py-1 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">最近 {{ summary.total }} 条</span>
        <span class="rounded-full bg-green-100 px-2.5 py-1 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300">放草 {{ summary.weed }}</span>
        <span class="rounded-full bg-orange-100 px-2.5 py-1 text-xs text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">放虫 {{ summary.insect }}</span>
        <span class="rounded-full bg-red-100 px-2.5 py-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">偷菜 {{ summary.steal }}</span>
      </div>

      <div v-if="visitorLogs.length === 0" class="glass-text-muted flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-gray-300/70 bg-black/5 py-10 text-sm dark:border-white/15 dark:bg-black/20">
        <div class="i-carbon-face-wink text-2xl" />
        <p>暂无访客事件</p>
      </div>

      <div v-else class="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
        <div
          v-for="(log, idx) in visitorLogs"
          :key="`${log.ts || idx}_${log.msg || ''}`"
          class="glass-panel border border-white/20 rounded-lg p-3 dark:border-white/10"
        >
          <div class="mb-1 flex flex-wrap items-center gap-2 text-xs">
            <span class="rounded px-2 py-0.5 font-medium" :class="getTypeClass(String(log?.meta?.result || ''))">{{ getTypeText(String(log?.meta?.result || '')) }}</span>
            <span class="glass-text-muted">{{ formatTime(log.time) }}</span>
            <span class="glass-text-muted">地块 #{{ Number(log?.meta?.landId || 0) || '-' }}</span>
            <span v-if="Number(log?.meta?.gid || 0) > 0" class="glass-text-muted">GID {{ Number(log?.meta?.gid || 0) }}</span>
          </div>
          <div class="glass-text-main text-sm leading-6">
            {{ String(log.msg || '').trim() || '访客事件' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
