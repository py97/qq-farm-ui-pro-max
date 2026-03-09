<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

type AccountItem = {
  id: string
  name?: string
  nick?: string
  uin?: string | number
  platform?: string
  username?: string
  accountMode?: 'main' | 'alt' | 'safe'
  effectiveMode?: 'main' | 'alt' | 'safe'
  collaborationEnabled?: boolean
  degradeReason?: string
  degradeReasonLabel?: string
  accountZone?: string
  running?: boolean
  connected?: boolean
}

type UserItem = {
  username: string
  role: string
}

const loading = ref(false)
const accounts = ref<AccountItem[]>([])
const users = ref<UserItem[]>([])

const currentUser = computed(() => {
  try {
    return JSON.parse(localStorage.getItem('current_user') || 'null')
  }
  catch {
    return null
  }
})

const currentUsername = computed(() => String(currentUser.value?.username || '').trim())
const roleMap = computed(() => {
  const map = new Map<string, string>()
  for (const user of users.value) {
    map.set(String(user.username || '').trim(), String(user.role || 'user').trim())
  }
  return map
})

function resolveModeMeta(mode?: string) {
  if (mode === 'alt') {
    return {
      label: '小号',
      badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    }
  }
  if (mode === 'safe') {
    return {
      label: '避险',
      badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    }
  }
  return {
    label: '主号',
    badge: 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300',
  }
}

function resolveAccountMode(mode?: string) {
  if (mode === 'alt' || mode === 'safe')
    return mode
  return 'main'
}

function resolveEffectiveMode(mode?: string) {
  if (mode === 'alt' || mode === 'safe')
    return mode
  return 'main'
}

function resolveDegradeReasonLabel(reason?: string) {
  const raw = String(reason || '').trim()
  if (raw === 'missing_mode_peer')
    return '未找到可协同的对端账号'
  if (raw === 'cross_zone_peer_only')
    return '仅存在跨区账号，未命中同区约束'
  if (raw === 'friend_relation_unknown')
    return '好友关系尚未完成预热'
  if (raw === 'not_game_friend')
    return '同 owner 对端账号不是游戏好友'
  return ''
}

function resolveModeExecutionMeta(account: AccountItem) {
  const configuredMode = resolveAccountMode(account.accountMode)
  const effectiveMode = resolveEffectiveMode(account.effectiveMode || configuredMode)
  const backendLabel = String(account.degradeReasonLabel || '').trim()
  const degradeLabel = backendLabel || resolveDegradeReasonLabel(account.degradeReason)

  if (effectiveMode !== configuredMode) {
    return {
      label: `生效:${resolveModeMeta(effectiveMode).label}`,
      badge: resolveModeMeta(effectiveMode).badge,
      note: degradeLabel || '当前已按更保守模式执行',
      noteClass: 'text-amber-500 dark:text-amber-300',
    }
  }

  if (account.collaborationEnabled) {
    return {
      label: '协同命中',
      badge: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
      note: '同区 / 游戏好友约束已命中',
      noteClass: 'text-sky-500 dark:text-sky-300',
    }
  }

  if (degradeLabel) {
    return {
      label: '独立执行',
      badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
      note: degradeLabel,
      noteClass: 'text-gray-500 dark:text-gray-400',
    }
  }

  return null
}

function resolvePlatformLabel(platform?: string) {
  const raw = String(platform || '').trim().toLowerCase()
  if (raw === 'qq')
    return 'QQ'
  if (raw === 'wx_ipad')
    return 'iPad微信'
  if (raw === 'wx_car')
    return '车机微信'
  if (raw.startsWith('wx'))
    return '微信'
  return '未知平台'
}

function resolveZoneLabel(zone?: string, platform?: string) {
  const raw = String(zone || '').trim().toLowerCase()
  if (raw === 'qq_zone')
    return 'QQ区'
  if (raw === 'wechat_zone')
    return '微信区'
  const platformLabel = resolvePlatformLabel(platform)
  if (platformLabel.includes('QQ'))
    return 'QQ区'
  if (platformLabel.includes('微信'))
    return '微信区'
  return '未识别区服'
}

function resolveOwnerMeta(account: AccountItem) {
  const owner = String(account.username || '').trim()
  if (!owner) {
    return {
      label: '未归属 / 系统账号',
      tone: 'text-slate-700 dark:text-slate-200',
      badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
      section: 'unowned',
    }
  }
  if (owner === currentUsername.value) {
    return {
      label: '我自己登录的账号',
      tone: 'text-primary-700 dark:text-primary-300',
      badge: 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300',
      section: 'mine',
    }
  }
  const role = roleMap.value.get(owner)
  if (role === 'admin') {
    return {
      label: `其他管理员: ${owner}`,
      tone: 'text-violet-700 dark:text-violet-300',
      badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
      section: 'other_admin',
    }
  }
  return {
    label: `普通用户: ${owner}`,
    tone: 'text-amber-700 dark:text-amber-300',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    section: 'other_user',
  }
}

const sortedAccounts = computed(() => {
  return [...accounts.value].sort((a, b) => {
    const aPriority = a.username === currentUsername.value ? 2 : (a.username ? 1 : 0)
    const bPriority = b.username === currentUsername.value ? 2 : (b.username ? 1 : 0)
    if (aPriority !== bPriority)
      return bPriority - aPriority
    return Number(b.id || 0) - Number(a.id || 0)
  })
})

const summary = computed(() => {
  return sortedAccounts.value.reduce((acc, item) => {
    const ownerMeta = resolveOwnerMeta(item)
    if (ownerMeta.section === 'mine')
      acc.mine += 1
    else if (ownerMeta.section === 'other_user')
      acc.otherUsers += 1
    else if (ownerMeta.section === 'other_admin')
      acc.otherAdmins += 1
    else
      acc.unowned += 1
    return acc
  }, { mine: 0, otherUsers: 0, otherAdmins: 0, unowned: 0 })
})

async function loadData() {
  loading.value = true
  try {
    const [accountRes, userRes] = await Promise.all([
      api.get('/api/accounts'),
      api.get('/api/users'),
    ])
    accounts.value = accountRes.data?.data?.accounts || []
    users.value = userRes.data?.users || []
  }
  finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="mx-auto max-w-7xl w-full p-4 space-y-4">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h1 class="text-2xl font-bold">
          账号归属
        </h1>
        <p class="glass-text-muted mt-1 text-sm">
          管理员专用视图，区分自己登录的账号、普通用户账号和未归属账号。
        </p>
      </div>
      <BaseButton variant="primary" :loading="loading" @click="loadData">
        <div class="i-carbon-renew mr-1" />
        刷新归属数据
      </BaseButton>
    </div>

    <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
      <div class="glass-panel rounded-xl p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          我自己登录的账号
        </div>
        <div class="mt-2 text-3xl text-primary-600 font-bold dark:text-primary-300">
          {{ summary.mine }}
        </div>
      </div>
      <div class="glass-panel rounded-xl p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          普通用户账号
        </div>
        <div class="mt-2 text-3xl text-amber-600 font-bold dark:text-amber-300">
          {{ summary.otherUsers }}
        </div>
      </div>
      <div class="glass-panel rounded-xl p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          其他管理员账号
        </div>
        <div class="mt-2 text-3xl text-violet-600 font-bold dark:text-violet-300">
          {{ summary.otherAdmins }}
        </div>
      </div>
      <div class="glass-panel rounded-xl p-4">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          未归属 / 系统账号
        </div>
        <div class="mt-2 text-3xl text-slate-700 font-bold dark:text-slate-200">
          {{ summary.unowned }}
        </div>
      </div>
    </div>

    <div class="glass-panel overflow-hidden rounded-2xl">
      <div class="border-b border-gray-200/70 px-4 py-3 dark:border-white/10">
        <div class="text-sm text-gray-500 dark:text-gray-400">
          当前管理员：<span class="font-semibold text-gray-900 dark:text-gray-100">{{ currentUsername || '未识别' }}</span>
        </div>
      </div>

      <div v-if="loading" class="flex items-center justify-center px-4 py-16 text-sm text-gray-500 dark:text-gray-400">
        正在加载账号归属...
      </div>

      <div v-else-if="sortedAccounts.length === 0" class="px-4 py-16 text-center text-sm text-gray-500 dark:text-gray-400">
        暂无账号数据
      </div>

      <div v-else class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-black/3 text-left text-xs text-gray-500 uppercase tracking-[0.18em] dark:bg-white/5 dark:text-gray-400">
            <tr>
              <th class="px-4 py-3 font-medium">
                账号
              </th>
              <th class="px-4 py-3 font-medium">
                所属人
              </th>
              <th class="px-4 py-3 font-medium">
                区服 / 平台
              </th>
              <th class="px-4 py-3 font-medium">
                模式
              </th>
              <th class="px-4 py-3 font-medium">
                状态
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="account in sortedAccounts"
              :key="account.id"
              class="border-t border-gray-200/60 transition hover:bg-black/3 dark:border-white/8 dark:hover:bg-white/4"
            >
              <td class="px-4 py-4 align-top">
                <div class="font-semibold">
                  {{ account.name || account.nick || account.id }}
                </div>
                <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  UIN: {{ account.uin || '未绑定' }}
                </div>
              </td>
              <td class="px-4 py-4 align-top">
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="resolveOwnerMeta(account).badge"
                >
                  {{ resolveOwnerMeta(account).label }}
                </span>
              </td>
              <td class="px-4 py-4 align-top">
                <div class="font-medium">
                  {{ resolveZoneLabel(account.accountZone, account.platform) }}
                </div>
                <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {{ resolvePlatformLabel(account.platform) }}
                </div>
              </td>
              <td class="px-4 py-4 align-top">
                <div class="space-y-2">
                  <span
                    class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                    :class="resolveModeMeta(resolveAccountMode(account.accountMode)).badge"
                  >
                    配置:{{ resolveModeMeta(resolveAccountMode(account.accountMode)).label }}
                  </span>
                  <div v-if="resolveModeExecutionMeta(account)" class="flex flex-wrap items-center gap-2">
                    <span
                      class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                      :class="resolveModeExecutionMeta(account)?.badge"
                    >
                      {{ resolveModeExecutionMeta(account)?.label }}
                    </span>
                  </div>
                  <div
                    v-if="resolveModeExecutionMeta(account)?.note"
                    class="text-xs leading-5"
                    :class="resolveModeExecutionMeta(account)?.noteClass"
                  >
                    {{ resolveModeExecutionMeta(account)?.note }}
                  </div>
                </div>
              </td>
              <td class="px-4 py-4 align-top">
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="account.connected
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : account.running
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'"
                >
                  {{ account.connected ? '在线' : account.running ? '启动中' : '已停止' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
