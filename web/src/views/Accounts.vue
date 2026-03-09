<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import { adminToken } from '@/utils/auth'
import { useAvatar } from '@/utils/avatar'

interface CurrentUser {
  username?: string
  role?: string
}

interface UserItem {
  username: string
  role: string
}

type OwnershipSection = 'mine' | 'other_user' | 'other_admin' | 'unowned'
type OwnershipFilter = OwnershipSection | ''
type PlatformFilter = 'all' | 'qq' | 'wechat'
type StateFilter = 'all' | 'online' | 'starting' | 'offline'
type SortMode = 'smart' | 'recent' | 'name' | 'platform'
type ViewMode = 'standard' | 'compact' | 'table'
type TableSortKey = 'account' | 'owner' | 'platform' | 'activity' | 'mode' | 'state'
type SortDirection = 'asc' | 'desc'
type TableColumnKey = 'owner' | 'platform' | 'activity' | 'mode' | 'state' | 'actions'
type ActionHistoryStatus = 'success' | 'warning' | 'error'

interface ActionHistoryItem {
  id: string
  actionLabel: string
  status: ActionHistoryStatus
  timestamp: number
  totalCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  affectedNames: string[]
  failedNames: string[]
  targetLabel?: string
}

const VIEW_MODE_STORAGE_KEY = 'accounts_view_mode'
const TABLE_SORT_STORAGE_KEY = 'accounts_table_sort'
const TABLE_COLUMNS_STORAGE_KEY = 'accounts_table_columns'
const ACTION_HISTORY_STORAGE_KEY = 'accounts_action_history'
const ACTION_HISTORY_LIMIT = 8
const UNOWNED_TRANSFER_VALUE = '__unowned__'

const { getAvatarUrl, markFailed } = useAvatar()

const route = useRoute()
const router = useRouter()
const accountStore = useAccountStore()
const toast = useToastStore()
const { accounts, loading } = storeToRefs(accountStore)

const showModal = ref(false)
const showDeleteConfirm = ref(false)
const deleteLoading = ref(false)
const editingAccount = ref<any>(null)
const accountToDelete = ref<any>(null)
const currentUser = ref<CurrentUser | null>(null)
const users = ref<UserItem[]>([])
const searchKeyword = ref('')
const ownershipFilter = ref<OwnershipFilter>('')
const platformFilter = ref<PlatformFilter>('all')
const stateFilter = ref<StateFilter>('all')
const sortMode = ref<SortMode>('smart')
const viewMode = ref<ViewMode>('standard')
const tableSortKey = ref<TableSortKey>('activity')
const tableSortDirection = ref<SortDirection>('desc')
const selectedAccountIds = ref<string[]>([])
const batchLoading = ref(false)
const batchActionType = ref('')
const safeCheckingId = ref('')
const exportLoading = ref(false)
const exportScope = ref<'all' | 'selected' | ''>('')
const transferOwnershipTarget = ref('')
const transferLoading = ref(false)
const showBatchDeleteConfirm = ref(false)
const batchDeleteLoading = ref(false)
const showColumnSettings = ref(false)
const actionHistory = ref<ActionHistoryItem[]>([])
const tableColumnVisibility = ref<Record<TableColumnKey, boolean>>({
  owner: true,
  platform: true,
  activity: true,
  mode: true,
  state: true,
  actions: true,
})

const platformOptions = [
  { label: '全部平台', value: 'all' },
  { label: 'QQ', value: 'qq' },
  { label: '微信', value: 'wechat' },
]

const stateOptions = [
  { label: '全部状态', value: 'all' },
  { label: '运行中', value: 'online' },
  { label: '启动中', value: 'starting' },
  { label: '已停止', value: 'offline' },
]

const sortOptions = [
  { label: '智能排序', value: 'smart', description: '在线优先，其次最近登录/更新' },
  { label: '最近登录/更新', value: 'recent', description: '优先展示最近变更的账号' },
  { label: '名称排序', value: 'name', description: '按备注名称或昵称排序' },
  { label: '平台排序', value: 'platform', description: '按 QQ / 微信平台分组排序' },
]

const viewOptions = [
  { label: '标准卡片', shortLabel: '标准', value: 'standard' as ViewMode, icon: 'i-carbon-apps' },
  { label: '紧凑卡片', shortLabel: '紧凑', value: 'compact' as ViewMode, icon: 'i-carbon-grid' },
  { label: '表格视图', shortLabel: '表格', value: 'table' as ViewMode, icon: 'i-carbon-data-table' },
]

const tableColumnOptions: { key: TableColumnKey, label: string }[] = [
  { key: 'owner', label: '归属' },
  { key: 'platform', label: '平台 / 区服' },
  { key: 'activity', label: '最近登录' },
  { key: 'mode', label: '模式' },
  { key: 'state', label: '状态' },
  { key: 'actions', label: '操作' },
]

function readCurrentUser() {
  try {
    const raw = localStorage.getItem('current_user')
    if (!raw)
      return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  }
  catch {
    return null
  }
}

function refreshCurrentUser() {
  currentUser.value = readCurrentUser()
}

function readViewMode(): ViewMode {
  try {
    const raw = String(localStorage.getItem(VIEW_MODE_STORAGE_KEY) || '').trim()
    if (raw === 'compact' || raw === 'table' || raw === 'standard')
      return raw
  }
  catch {
  }
  return 'standard'
}

function normalizeOwnershipFilter(value: unknown): OwnershipFilter {
  const raw = String(value || '').trim()
  if (raw === 'mine' || raw === 'other_user' || raw === 'other_admin' || raw === 'unowned')
    return raw
  return ''
}

function normalizePlatformFilter(value: unknown): PlatformFilter {
  const raw = String(value || '').trim()
  if (raw === 'qq' || raw === 'wechat')
    return raw
  return 'all'
}

function normalizeStateFilter(value: unknown): StateFilter {
  const raw = String(value || '').trim()
  if (raw === 'online' || raw === 'starting' || raw === 'offline')
    return raw
  return 'all'
}

function normalizeSortMode(value: unknown): SortMode {
  const raw = String(value || '').trim()
  if (raw === 'recent' || raw === 'name' || raw === 'platform')
    return raw
  return 'smart'
}

function normalizeViewMode(value: unknown): ViewMode {
  const raw = String(value || '').trim()
  if (raw === 'compact' || raw === 'table')
    return raw
  return 'standard'
}

function normalizeTableSortKey(value: unknown): TableSortKey {
  const raw = String(value || '').trim()
  if (raw === 'account' || raw === 'owner' || raw === 'platform' || raw === 'activity' || raw === 'mode' || raw === 'state')
    return raw
  return 'activity'
}

function normalizeSortDirection(value: unknown): SortDirection {
  return String(value || '').trim() === 'asc' ? 'asc' : 'desc'
}

function getQueryValue(value: unknown) {
  if (Array.isArray(value))
    return String(value[0] || '').trim()
  return String(value || '').trim()
}

function setViewMode(mode: ViewMode) {
  viewMode.value = mode
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
  }
  catch {
  }
}

function readTableSortState() {
  try {
    const raw = JSON.parse(localStorage.getItem(TABLE_SORT_STORAGE_KEY) || '{}')
    tableSortKey.value = normalizeTableSortKey(raw.key)
    tableSortDirection.value = normalizeSortDirection(raw.direction)
  }
  catch {
    tableSortKey.value = 'activity'
    tableSortDirection.value = 'desc'
  }
}

function persistTableSortState() {
  try {
    localStorage.setItem(TABLE_SORT_STORAGE_KEY, JSON.stringify({
      key: tableSortKey.value,
      direction: tableSortDirection.value,
    }))
  }
  catch {
  }
}

function readTableColumnVisibility() {
  try {
    const raw = JSON.parse(localStorage.getItem(TABLE_COLUMNS_STORAGE_KEY) || '{}')
    if (raw && typeof raw === 'object') {
      tableColumnVisibility.value = {
        owner: raw.owner !== false,
        platform: raw.platform !== false,
        activity: raw.activity !== false,
        mode: raw.mode !== false,
        state: raw.state !== false,
        actions: raw.actions !== false,
      }
    }
  }
  catch {
  }
}

function persistTableColumnVisibility() {
  try {
    localStorage.setItem(TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(tableColumnVisibility.value))
  }
  catch {
  }
}

function toggleTableColumn(key: TableColumnKey) {
  tableColumnVisibility.value = {
    ...tableColumnVisibility.value,
    [key]: !tableColumnVisibility.value[key],
  }
  persistTableColumnVisibility()
}

function readActionHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTION_HISTORY_STORAGE_KEY) || '[]')
    if (!Array.isArray(raw)) {
      actionHistory.value = []
      return
    }
    actionHistory.value = raw
      .filter(item => item && typeof item === 'object')
      .map((item: any) => ({
        id: String(item.id || `${item.actionLabel || 'history'}-${item.timestamp || Date.now()}`),
        actionLabel: String(item.actionLabel || '批量操作'),
        status: item.status === 'success' || item.status === 'error' ? item.status : 'warning',
        timestamp: Number(item.timestamp || 0),
        totalCount: Number(item.totalCount || 0),
        successCount: Number(item.successCount || 0),
        failedCount: Number(item.failedCount || 0),
        skippedCount: Number(item.skippedCount || 0),
        affectedNames: Array.isArray(item.affectedNames) ? item.affectedNames.map((name: unknown) => String(name || '')).filter(Boolean) : [],
        failedNames: Array.isArray(item.failedNames) ? item.failedNames.map((name: unknown) => String(name || '')).filter(Boolean) : [],
        targetLabel: String(item.targetLabel || '').trim() || undefined,
      }))
      .filter(item => item.timestamp > 0)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, ACTION_HISTORY_LIMIT)
  }
  catch {
    actionHistory.value = []
  }
}

function persistActionHistory() {
  try {
    localStorage.setItem(ACTION_HISTORY_STORAGE_KEY, JSON.stringify(actionHistory.value))
  }
  catch {
  }
}

function resolveActionHistoryStatus(successCount: number, failedCount: number, skippedCount: number): ActionHistoryStatus {
  if (successCount > 0 && failedCount === 0)
    return 'success'
  if (successCount > 0 || skippedCount > 0)
    return 'warning'
  return 'error'
}

function pushActionHistory(params: {
  actionLabel: string
  totalCount: number
  successCount: number
  failedNames?: string[]
  skippedCount?: number
  affectedNames?: string[]
  targetLabel?: string
}) {
  const failedNames = (params.failedNames || []).filter(Boolean)
  const entry: ActionHistoryItem = {
    id: `${params.actionLabel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actionLabel: params.actionLabel,
    status: resolveActionHistoryStatus(params.successCount, failedNames.length, params.skippedCount || 0),
    timestamp: Date.now(),
    totalCount: params.totalCount,
    successCount: params.successCount,
    failedCount: failedNames.length,
    skippedCount: params.skippedCount || 0,
    affectedNames: (params.affectedNames || []).filter(Boolean).slice(0, 6),
    failedNames: failedNames.slice(0, 6),
    targetLabel: params.targetLabel,
  }

  actionHistory.value = [entry, ...actionHistory.value].slice(0, ACTION_HISTORY_LIMIT)
  persistActionHistory()
}

function clearActionHistory() {
  actionHistory.value = []
  persistActionHistory()
  toast.success('最近操作记录已清空')
}

function applyQueryState() {
  const query = route.query
  if (Object.prototype.hasOwnProperty.call(query, 'q'))
    searchKeyword.value = getQueryValue(query.q)
  if (Object.prototype.hasOwnProperty.call(query, 'owner'))
    ownershipFilter.value = normalizeOwnershipFilter(getQueryValue(query.owner))
  if (Object.prototype.hasOwnProperty.call(query, 'platform'))
    platformFilter.value = normalizePlatformFilter(getQueryValue(query.platform))
  if (Object.prototype.hasOwnProperty.call(query, 'state'))
    stateFilter.value = normalizeStateFilter(getQueryValue(query.state))
  if (Object.prototype.hasOwnProperty.call(query, 'sort'))
    sortMode.value = normalizeSortMode(getQueryValue(query.sort))
  if (Object.prototype.hasOwnProperty.call(query, 'view'))
    viewMode.value = normalizeViewMode(getQueryValue(query.view))
  if (Object.prototype.hasOwnProperty.call(query, 'tableSort'))
    tableSortKey.value = normalizeTableSortKey(getQueryValue(query.tableSort))
  if (Object.prototype.hasOwnProperty.call(query, 'tableDirection'))
    tableSortDirection.value = normalizeSortDirection(getQueryValue(query.tableDirection))
}

function buildShareQuery() {
  const query: Record<string, string> = {}
  const keyword = searchKeyword.value.trim()

  if (keyword)
    query.q = keyword
  if (ownershipFilter.value)
    query.owner = ownershipFilter.value
  if (platformFilter.value !== 'all')
    query.platform = platformFilter.value
  if (stateFilter.value !== 'all')
    query.state = stateFilter.value
  if (sortMode.value !== 'smart')
    query.sort = sortMode.value
  if (viewMode.value !== 'standard')
    query.view = viewMode.value
  if (tableSortKey.value !== 'activity')
    query.tableSort = tableSortKey.value
  if (tableSortDirection.value !== 'desc')
    query.tableDirection = tableSortDirection.value

  return query
}

function getFailedNamesLabel(names: string[]) {
  const visibleNames = names.slice(0, 3)
  if (visibleNames.length === 0)
    return ''
  return `${visibleNames.join('、')}${names.length > visibleNames.length ? ' 等' : ''}`
}

function buildActionResultMessage(actionLabel: string, successCount: number, failedNames: string[] = [], skippedCount = 0) {
  const parts = []

  if (successCount > 0)
    parts.push(`成功 ${successCount} 个账号`)
  if (failedNames.length > 0)
    parts.push(`失败 ${failedNames.length} 个账号${getFailedNamesLabel(failedNames) ? `（${getFailedNamesLabel(failedNames)}）` : ''}`)
  if (skippedCount > 0)
    parts.push(`跳过 ${skippedCount} 个无需处理`)

  return parts.length > 0 ? `${actionLabel}完成，${parts.join('，')}` : `${actionLabel}完成`
}

function notifyBatchActionResult(actionLabel: string, successCount: number, failedNames: string[] = [], skippedCount = 0) {
  const message = buildActionResultMessage(actionLabel, successCount, failedNames, skippedCount)

  if (successCount > 0 && failedNames.length === 0)
    toast.success(message)
  else if (successCount > 0 || skippedCount > 0)
    toast.warning(message)
  else
    toast.error(message || `${actionLabel}失败，请稍后重试`)
}

function buildHistorySummaryText(item: ActionHistoryItem) {
  const lines = [
    `${item.actionLabel} · ${formatDateTime(item.timestamp)}`,
    buildActionResultMessage(item.actionLabel, item.successCount, item.failedNames, item.skippedCount),
  ]

  if (item.targetLabel)
    lines.push(`附加信息：${item.targetLabel}`)
  if (item.affectedNames.length > 0)
    lines.push(`涉及账号：${item.affectedNames.join('、')}${item.totalCount > item.affectedNames.length ? ' 等' : ''}`)

  return lines.join('\n')
}

async function copyLatestActionSummary() {
  const latestHistory = actionHistory.value[0]
  if (!latestHistory) {
    toast.warning('暂无最近操作记录可复制')
    return
  }
  await copyText(buildHistorySummaryText(latestHistory), '最近操作摘要已复制')
}

async function copyText(text: string, successMessage: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    }
    else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-999999px'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    toast.success(successMessage)
  }
  catch (error) {
    console.error('复制失败:', error)
    toast.error('复制失败，请手动复制')
  }
}

async function copyCurrentFilterLink() {
  const resolved = router.resolve({
    path: route.path,
    query: buildShareQuery(),
  })
  const absoluteUrl = `${window.location.origin}${resolved.fullPath}`
  await copyText(absoluteUrl, '当前筛选链接已复制')
}

const isAdmin = computed(() => currentUser.value?.role === 'admin')
const currentUsername = computed(() => String(currentUser.value?.username || '').trim())
const isCompactView = computed(() => viewMode.value === 'compact')
const isTableView = computed(() => viewMode.value === 'table')
const cardGridClass = computed(() =>
  isCompactView.value
    ? 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
    : 'grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3',
)
const roleMap = computed(() => {
  const map = new Map<string, string>()
  for (const user of users.value) {
    map.set(String(user.username || '').trim(), String(user.role || 'user').trim())
  }
  if (currentUsername.value && !map.has(currentUsername.value)) {
    map.set(currentUsername.value, String(currentUser.value?.role || 'user').trim())
  }
  return map
})
const ownershipTransferOptions = computed(() => {
  const options = [
    { label: '设为未归属 / 系统账号', value: UNOWNED_TRANSFER_VALUE, description: '解除绑定，转为公共账号' },
  ]
  for (const user of users.value) {
    const username = String(user.username || '').trim()
    if (!username)
      continue
    options.push({
      label: `${username}${user.role === 'admin' ? ' (管理员)' : ''}`,
      value: username,
      description: user.role === 'admin' ? '转移给管理员账号' : '转移给普通用户账号',
    })
  }
  return options
})
const visibleTableColumns = computed(() => tableColumnVisibility.value)
const latestActionHistory = computed(() => actionHistory.value[0] || null)
const recentActionHistory = computed(() => actionHistory.value.slice(0, 4))
const actionHistoryCount = computed(() => actionHistory.value.length)

function getActionHistoryStatusMeta(status: ActionHistoryStatus) {
  if (status === 'success') {
    return {
      label: '执行成功',
      badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      accent: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
      icon: 'i-carbon-checkmark-filled',
    }
  }
  if (status === 'error') {
    return {
      label: '执行失败',
      badge: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      accent: 'border-red-500/20 bg-red-500/10 text-red-200',
      icon: 'i-carbon-warning-filled',
    }
  }
  return {
    label: '部分完成',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    accent: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
    icon: 'i-carbon-warning-alt-filled',
  }
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

function resolveZoneLabel(acc: any) {
  const zone = String(acc?.accountZone || '').trim().toLowerCase()
  if (zone === 'qq_zone')
    return 'QQ区'
  if (zone === 'wechat_zone')
    return '微信区'
  const platformLabel = resolvePlatformLabel(acc?.platform)
  if (platformLabel.includes('QQ'))
    return 'QQ区'
  if (platformLabel.includes('微信'))
    return '微信区'
  return '未识别区服'
}

function resolvePlatformFamily(platform?: string): PlatformFilter {
  const raw = String(platform || '').trim().toLowerCase()
  if (raw === 'qq')
    return 'qq'
  if (raw.startsWith('wx'))
    return 'wechat'
  return 'all'
}

function resolveOwnerMeta(acc: any) {
  const owner = String(acc?.username || '').trim()
  if (!owner) {
    return {
      section: 'unowned' as OwnershipSection,
      label: '未归属 / 系统账号',
      badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
      tabActive: 'border-slate-300/70 bg-slate-500/15 text-slate-100 shadow-[0_8px_30px_rgba(148,163,184,0.2)]',
      tabIdle: 'border-slate-400/20 bg-black/10 text-slate-300/80 hover:bg-slate-500/10',
      cardGlow: 'hover:border-slate-300/35',
      shortLabel: '未归属',
      ownerText: '系统公共账号',
    }
  }
  if (owner === currentUsername.value) {
    return {
      section: 'mine' as OwnershipSection,
      label: '我自己登录的账号',
      badge: 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300',
      tabActive: 'border-primary-400/50 bg-primary-500/18 text-primary-50 shadow-[0_8px_30px_rgba(34,197,94,0.2)]',
      tabIdle: 'border-primary-500/20 bg-black/10 text-primary-200/85 hover:bg-primary-500/10',
      cardGlow: 'hover:border-primary-400/35',
      shortLabel: '我自己',
      ownerText: owner,
    }
  }
  if (roleMap.value.get(owner) === 'admin') {
    return {
      section: 'other_admin' as OwnershipSection,
      label: `其他管理员账号: ${owner}`,
      badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
      tabActive: 'border-violet-400/45 bg-violet-500/16 text-violet-50 shadow-[0_8px_30px_rgba(167,139,250,0.2)]',
      tabIdle: 'border-violet-500/20 bg-black/10 text-violet-200/85 hover:bg-violet-500/10',
      cardGlow: 'hover:border-violet-400/35',
      shortLabel: '其他管理员',
      ownerText: owner,
    }
  }
  return {
    section: 'other_user' as OwnershipSection,
    label: `普通用户账号: ${owner}`,
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    tabActive: 'border-amber-400/45 bg-amber-500/16 text-amber-50 shadow-[0_8px_30px_rgba(245,158,11,0.2)]',
    tabIdle: 'border-amber-500/20 bg-black/10 text-amber-200/85 hover:bg-amber-500/10',
    cardGlow: 'hover:border-amber-400/35',
    shortLabel: '普通用户',
    ownerText: owner,
  }
}

function resolveRuntimeState(acc: any) {
  if (acc?.connected) {
    return {
      section: 'online' as const,
      label: '运行中',
      dot: 'bg-emerald-400',
      badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    }
  }
  if (acc?.running) {
    return {
      section: 'starting' as const,
      label: '启动中',
      dot: 'bg-amber-400',
      badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    }
  }
  return {
    section: 'offline' as const,
    label: '已停止',
    dot: 'bg-slate-300 dark:bg-slate-500',
    badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  }
}

function getRuntimeRank(acc: any) {
  const section = resolveRuntimeState(acc).section
  if (section === 'online')
    return 3
  if (section === 'starting')
    return 2
  return 1
}

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

function resolveAccountMode(acc: any) {
  return String(acc?.accountMode || (acc as any)?.account_mode || 'main')
}

function resolveEffectiveMode(acc: any) {
  const raw = String(acc?.effectiveMode || '').trim()
  if (raw === 'alt' || raw === 'safe')
    return raw
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

function resolveModeExecutionMeta(acc: any) {
  const configuredMode = resolveAccountMode(acc)
  const effectiveMode = resolveEffectiveMode(acc)
  const backendLabel = String(acc?.degradeReasonLabel || '').trim()
  const degradeLabel = backendLabel || resolveDegradeReasonLabel(acc?.degradeReason)

  if (effectiveMode !== configuredMode) {
    return {
      label: `生效:${resolveModeMeta(effectiveMode).label}`,
      badge: resolveModeMeta(effectiveMode).badge,
      note: degradeLabel || '当前已按更保守模式执行',
      noteClass: 'text-amber-500 dark:text-amber-300',
    }
  }

  if (acc?.collaborationEnabled) {
    return {
      label: '协同命中',
      badge: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
      note: '同区/游戏好友约束已命中',
      noteClass: 'text-sky-500 dark:text-sky-300',
    }
  }

  if (degradeLabel) {
    return {
      label: '独立执行',
      badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
      note: degradeLabel,
      noteClass: 'glass-text-muted',
    }
  }

  return null
}

function getModeButtonClasses(acc: any, mode: 'main' | 'alt' | 'safe') {
  const current = resolveAccountMode(acc)
  if (mode === 'main') {
    return current === 'main'
      ? 'bg-primary-500/10 text-primary-600 dark:text-primary-400'
      : 'text-gray-500 hover:bg-black/5 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200'
  }
  if (mode === 'alt') {
    return current === 'alt'
      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
      : 'text-gray-500 hover:bg-black/5 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200'
  }
  return current === 'safe'
    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : 'text-gray-500 hover:bg-black/5 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200'
}

function getModeRank(acc: any) {
  const current = resolveAccountMode(acc)
  if (current === 'main')
    return 3
  if (current === 'safe')
    return 2
  return 1
}

function formatDateTime(ts?: number | string | null) {
  const time = Number(ts || 0)
  if (!Number.isFinite(time) || time <= 0)
    return '暂无记录'
  const date = new Date(time)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function formatActionTime(ts?: number | string | null) {
  const time = Number(ts || 0)
  if (!Number.isFinite(time) || time <= 0)
    return '暂无记录'

  const diff = Date.now() - time
  if (diff < 60 * 1000)
    return '刚刚'
  if (diff < 60 * 60 * 1000)
    return `${Math.max(1, Math.floor(diff / (60 * 1000)))} 分钟前`
  if (diff < 24 * 60 * 60 * 1000)
    return `${Math.max(1, Math.floor(diff / (60 * 60 * 1000)))} 小时前`
  return formatDateTime(time)
}

function getActivityTime(acc: any) {
  const time = Number(acc?.lastLoginAt || acc?.updatedAt || 0)
  return Number.isFinite(time) ? time : 0
}

function getLastLoginLabel(acc: any) {
  return formatDateTime(getActivityTime(acc))
}

function getAccountDisplayName(acc: any) {
  return acc?.name || acc?.nick || acc?.id || '未命名账号'
}

function getAccountSubline(acc: any) {
  const zone = resolveZoneLabel(acc)
  const accountRef = acc?.uin || '未绑定'
  return `${zone}: ${accountRef}`
}

function compareText(a: any, b: any) {
  return String(a || '').localeCompare(String(b || ''), 'zh-CN')
}

function getOwnerSortValue(acc: any) {
  const ownerMeta = resolveOwnerMeta(acc)
  return `${ownerMeta.shortLabel}-${ownerMeta.ownerText}`
}

function getTableSortValue(acc: any, key: TableSortKey) {
  if (key === 'account')
    return getAccountDisplayName(acc)
  if (key === 'owner')
    return getOwnerSortValue(acc)
  if (key === 'platform')
    return `${resolvePlatformLabel(acc?.platform)}-${resolveZoneLabel(acc)}`
  if (key === 'activity')
    return getActivityTime(acc)
  if (key === 'mode')
    return getModeRank(acc)
  return getRuntimeRank(acc)
}

function toggleTableSort(key: TableSortKey) {
  if (tableSortKey.value === key) {
    tableSortDirection.value = tableSortDirection.value === 'asc' ? 'desc' : 'asc'
    persistTableSortState()
    return
  }
  tableSortKey.value = key
  tableSortDirection.value = key === 'account' || key === 'owner' || key === 'platform' ? 'asc' : 'desc'
  persistTableSortState()
}

function getTableSortIcon(key: TableSortKey) {
  if (tableSortKey.value !== key)
    return 'i-carbon-arrows-vertical'
  return tableSortDirection.value === 'asc' ? 'i-carbon-arrow-up' : 'i-carbon-arrow-down'
}

function getTableSortLabel(key: TableSortKey) {
  const labels: Record<TableSortKey, string> = {
    account: '账号',
    owner: '归属',
    platform: '平台',
    activity: '最近登录',
    mode: '模式',
    state: '状态',
  }
  return `${labels[key]} ${tableSortDirection.value === 'asc' ? '升序' : '降序'}`
}

function escapeCsvCell(value: any) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim()
  if (/[",]/.test(text))
    return `"${text.replace(/"/g, '""')}"`
  return text
}

function buildSearchText(acc: any) {
  const ownerMeta = resolveOwnerMeta(acc)
  return [
    getAccountDisplayName(acc),
    acc?.nick,
    acc?.uin,
    acc?.id,
    acc?.username,
    ownerMeta.label,
    ownerMeta.ownerText,
    resolvePlatformLabel(acc?.platform),
    resolveZoneLabel(acc),
    resolveRuntimeState(acc).label,
  ].join(' ').toLowerCase()
}

async function loadUsers() {
  if (!isAdmin.value) {
    users.value = []
    return
  }
  try {
    const res = await api.get('/api/users')
    users.value = Array.isArray(res.data?.users) ? res.data.users : []
  }
  catch {
    users.value = []
  }
}

async function initializePage() {
  refreshCurrentUser()
  await Promise.all([
    accountStore.fetchAccounts(),
    loadUsers(),
  ])
}

const ownershipSummary = computed(() => {
  return accounts.value.reduce((acc, item) => {
    const section = resolveOwnerMeta(item).section
    if (section === 'mine')
      acc.mine += 1
    else if (section === 'other_user')
      acc.otherUser += 1
    else if (section === 'other_admin')
      acc.otherAdmin += 1
    else
      acc.unowned += 1
    return acc
  }, { mine: 0, otherUser: 0, otherAdmin: 0, unowned: 0 })
})

const ownershipTabs = computed(() => [
  { section: 'mine' as OwnershipSection, label: '自己登录的账号', count: ownershipSummary.value.mine },
  { section: 'other_user' as OwnershipSection, label: '普通用户账号', count: ownershipSummary.value.otherUser },
  { section: 'other_admin' as OwnershipSection, label: '其他管理员账号', count: ownershipSummary.value.otherAdmin },
  { section: 'unowned' as OwnershipSection, label: '未归属账号', count: ownershipSummary.value.unowned },
])

function getOwnershipTabClasses(section: OwnershipSection, active: boolean) {
  const styles = {
    mine: {
      active: 'border-primary-400/50 bg-primary-500/18 text-primary-50 shadow-[0_8px_30px_rgba(34,197,94,0.2)]',
      idle: 'border-primary-500/20 bg-black/10 text-primary-200/85 hover:bg-primary-500/10',
    },
    other_user: {
      active: 'border-amber-400/45 bg-amber-500/16 text-amber-50 shadow-[0_8px_30px_rgba(245,158,11,0.2)]',
      idle: 'border-amber-500/20 bg-black/10 text-amber-200/85 hover:bg-amber-500/10',
    },
    other_admin: {
      active: 'border-violet-400/45 bg-violet-500/16 text-violet-50 shadow-[0_8px_30px_rgba(167,139,250,0.2)]',
      idle: 'border-violet-500/20 bg-black/10 text-violet-200/85 hover:bg-violet-500/10',
    },
    unowned: {
      active: 'border-slate-300/70 bg-slate-500/15 text-slate-100 shadow-[0_8px_30px_rgba(148,163,184,0.2)]',
      idle: 'border-slate-400/20 bg-black/10 text-slate-300/80 hover:bg-slate-500/10',
    },
  }
  return active ? styles[section].active : styles[section].idle
}

const currentOwnershipLabel = computed(() => {
  const active = ownershipTabs.value.find(item => item.section === ownershipFilter.value)
  return active ? active.label : '全部归属'
})

const currentViewLabel = computed(() =>
  viewOptions.find(item => item.value === viewMode.value)?.label || '标准卡片',
)

const currentTableSortLabel = computed(() => getTableSortLabel(tableSortKey.value))

const filteredAccounts = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  const result = [...accounts.value].filter((acc) => {
    const ownerMeta = resolveOwnerMeta(acc)
    if (ownershipFilter.value && ownerMeta.section !== ownershipFilter.value)
      return false
    if (platformFilter.value !== 'all' && resolvePlatformFamily(acc?.platform) !== platformFilter.value)
      return false
    if (stateFilter.value !== 'all' && resolveRuntimeState(acc).section !== stateFilter.value)
      return false
    if (keyword && !buildSearchText(acc).includes(keyword))
      return false
    return true
  })

  result.sort((a, b) => {
    const timeA = getActivityTime(a)
    const timeB = getActivityTime(b)

    if (sortMode.value === 'recent') {
      if (timeA !== timeB)
        return timeB - timeA
      return String(getAccountDisplayName(a)).localeCompare(String(getAccountDisplayName(b)), 'zh-CN')
    }

    if (sortMode.value === 'name') {
      return String(getAccountDisplayName(a)).localeCompare(String(getAccountDisplayName(b)), 'zh-CN')
    }

    if (sortMode.value === 'platform') {
      const platformCompare = resolvePlatformLabel(a?.platform).localeCompare(resolvePlatformLabel(b?.platform), 'zh-CN')
      if (platformCompare !== 0)
        return platformCompare
      return String(getAccountDisplayName(a)).localeCompare(String(getAccountDisplayName(b)), 'zh-CN')
    }

    const stateDiff = getRuntimeRank(b) - getRuntimeRank(a)
    if (stateDiff !== 0)
      return stateDiff
    if (timeA !== timeB)
      return timeB - timeA
    return String(getAccountDisplayName(a)).localeCompare(String(getAccountDisplayName(b)), 'zh-CN')
  })

  return result
})

const tableAccounts = computed(() => {
  const result = [...filteredAccounts.value]
  result.sort((a, b) => {
    const valueA = getTableSortValue(a, tableSortKey.value)
    const valueB = getTableSortValue(b, tableSortKey.value)

    let compareResult = 0
    if (typeof valueA === 'number' && typeof valueB === 'number')
      compareResult = valueA - valueB
    else
      compareResult = compareText(valueA, valueB)

    if (compareResult === 0)
      compareResult = compareText(getAccountDisplayName(a), getAccountDisplayName(b))

    return tableSortDirection.value === 'asc' ? compareResult : -compareResult
  })
  return result
})

const displayAccounts = computed(() => isTableView.value ? tableAccounts.value : filteredAccounts.value)
const selectedAccounts = computed(() => {
  const selectedSet = new Set(selectedAccountIds.value.map(id => String(id || '')))
  return displayAccounts.value.filter(acc => selectedSet.has(String(acc.id || '')))
})
const startableSelectedAccounts = computed(() => selectedAccounts.value.filter(acc => !acc?.running))
const stoppableSelectedAccounts = computed(() => selectedAccounts.value.filter(acc => !!acc?.running))
const restartableSelectedAccounts = computed(() => selectedAccounts.value.filter(acc => !!acc?.running || !!acc?.connected))
const batchDeleteStats = computed(() => {
  const targets = selectedAccounts.value
  return {
    total: targets.length,
    running: targets.filter(acc => !!acc?.running).length,
    connected: targets.filter(acc => !!acc?.connected).length,
    current: targets.filter(acc => String(acc.id || '') === String(accountStore.currentAccountId || '')).length,
    names: targets.slice(0, 5).map(acc => getAccountDisplayName(acc)),
  }
})
const batchDeleteMessage = computed(() => {
  const stats = batchDeleteStats.value
  if (stats.total === 0)
    return '请先选择要删除的账号。'
  const parts = [
    `将删除 ${stats.total} 个账号。`,
    stats.running > 0 ? `其中 ${stats.running} 个正在运行，删除前会自动停止。` : '',
    stats.connected > 0 ? `其中 ${stats.connected} 个当前已连接。` : '',
    stats.current > 0 ? '包含当前选中的账号，删除后会自动取消当前选择。' : '',
    stats.names.length > 0 ? `示例账号：${stats.names.join('、')}${stats.total > stats.names.length ? ' 等' : ''}` : '',
  ].filter(Boolean)
  return parts.join(' ')
})
const transferTargetLabel = computed(() => {
  const found = ownershipTransferOptions.value.find(item => item.value === transferOwnershipTarget.value)
  return found ? found.label : ''
})
const canBatchTransferOwnership = computed(() =>
  isAdmin.value && selectedAccounts.value.length > 0 && !!transferOwnershipTarget.value,
)
const canBatchDelete = computed(() => selectedAccounts.value.length > 0)

watch(() => filteredAccounts.value.map(acc => String(acc.id || '')), (ids) => {
  const visibleIds = new Set(ids)
  selectedAccountIds.value = selectedAccountIds.value.filter(id => visibleIds.has(id))
})

watch([tableSortKey, tableSortDirection], () => {
  persistTableSortState()
})

const hasActiveFilters = computed(() =>
  !!searchKeyword.value.trim()
  || !!ownershipFilter.value
  || platformFilter.value !== 'all'
  || stateFilter.value !== 'all'
  || sortMode.value !== 'smart',
)

function clearFilters() {
  searchKeyword.value = ''
  ownershipFilter.value = ''
  platformFilter.value = 'all'
  stateFilter.value = 'all'
  sortMode.value = 'smart'
}

function toggleOwnershipFilter(section: OwnershipSection) {
  ownershipFilter.value = ownershipFilter.value === section ? '' : section
}

function isSelected(id: string) {
  return selectedAccountIds.value.includes(String(id || ''))
}

function toggleSelection(id: string) {
  const normalizedId = String(id || '')
  const index = selectedAccountIds.value.indexOf(normalizedId)
  if (index > -1) {
    selectedAccountIds.value.splice(index, 1)
  }
  else {
    selectedAccountIds.value.push(normalizedId)
  }
}

function selectAll() {
  selectedAccountIds.value = displayAccounts.value.map(acc => String(acc.id || ''))
}

function invertSelection() {
  const visibleIds = displayAccounts.value.map(acc => String(acc.id || ''))
  selectedAccountIds.value = visibleIds.filter(id => !selectedAccountIds.value.includes(id))
}

function clearSelection() {
  selectedAccountIds.value = []
}

async function exportAccounts(scope: 'all' | 'selected' = 'all') {
  const targetAccounts = scope === 'selected' ? selectedAccounts.value : displayAccounts.value
  if (targetAccounts.length === 0) {
    toast.warning(scope === 'selected' ? '请先选择要导出的账号' : '当前没有可导出的账号')
    return
  }

  const actionLabel = scope === 'selected' ? '导出已选账号' : '导出当前结果'
  try {
    exportLoading.value = true
    exportScope.value = scope
    const headers = [
      '账号名称',
      '昵称',
      '账号ID',
      'UIN',
      '归属分类',
      '归属账号',
      '平台',
      '区服',
      '最后登录',
      '首次录入',
      '模式',
      '状态',
      '运行中',
      '已连接',
      '最近错误',
    ]

    const rows = targetAccounts.map((acc) => {
      const ownerMeta = resolveOwnerMeta(acc)
      const runtimeState = resolveRuntimeState(acc)
      const modeMeta = resolveModeMeta(resolveAccountMode(acc))
      return [
        getAccountDisplayName(acc),
        acc?.nick || '',
        acc?.id || '',
        acc?.uin || '',
        ownerMeta.shortLabel,
        ownerMeta.ownerText,
        resolvePlatformLabel(acc?.platform),
        resolveZoneLabel(acc),
        getLastLoginLabel(acc),
        formatDateTime(acc?.createdAt),
        modeMeta.label,
        runtimeState.label,
        acc?.running ? '是' : '否',
        acc?.connected ? '是' : '否',
        acc?.wsError?.message || '',
      ].map(escapeCsvCell).join(',')
    })

    const csv = [`\uFEFF${headers.map(escapeCsvCell).join(',')}`, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `accounts-${scope}-${viewMode.value}-${Date.now()}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    window.URL.revokeObjectURL(url)
    toast.success(`已导出 ${targetAccounts.length} 个账号`)
    pushActionHistory({
      actionLabel,
      totalCount: targetAccounts.length,
      successCount: targetAccounts.length,
      affectedNames: targetAccounts.map(acc => getAccountDisplayName(acc)),
      targetLabel: `视图：${currentViewLabel.value} · 归属：${currentOwnershipLabel.value}`,
    })
  }
  catch (error) {
    console.error('导出失败:', error)
    toast.error('导出失败，请稍后重试')
  }
  finally {
    exportLoading.value = false
    exportScope.value = ''
  }
}

async function batchToggleAccounts(action: 'start' | 'stop') {
  const targetAccounts = action === 'start' ? startableSelectedAccounts.value : stoppableSelectedAccounts.value
  if (targetAccounts.length === 0) {
    toast.warning(action === 'start' ? '所选账号都已在运行，无需批量启动' : '所选账号都已停止，无需批量停止')
    return
  }

  const actionLabel = action === 'start' ? '批量启动' : '批量停止'
  const skippedCount = Math.max(selectedAccounts.value.length - targetAccounts.length, 0)
  let successCount = 0
  const failedNames: string[] = []
  try {
    batchLoading.value = true
    batchActionType.value = action
    for (const acc of targetAccounts) {
      const id = String(acc?.id || '').trim()
      if (!id)
        continue
      try {
        if (action === 'start')
          await api.post(`/api/accounts/${id}/start`)
        else
          await api.post(`/api/accounts/${id}/stop`)
        successCount += 1
      }
      catch (error) {
        console.error(`${actionLabel}失败:`, error)
        failedNames.push(getAccountDisplayName(acc))
      }
    }
    try {
      await accountStore.fetchAccounts()
    }
    catch (error) {
      console.error('刷新账号列表失败:', error)
      toast.warning(`${actionLabel}已执行，但账号列表刷新失败，请手动刷新确认最新状态`)
    }
    pushActionHistory({
      actionLabel,
      totalCount: targetAccounts.length,
      successCount,
      failedNames,
      skippedCount,
      affectedNames: targetAccounts.map(acc => getAccountDisplayName(acc)),
      targetLabel: `当前筛选：${filteredAccounts.value.length} 项`,
    })
    notifyBatchActionResult(actionLabel, successCount, failedNames, skippedCount)
  }
  catch (e: any) {
    console.error(`${actionLabel}失败: ${e.message}`)
    toast.error(`${actionLabel}失败，请稍后重试`)
  }
  finally {
    batchLoading.value = false
    batchActionType.value = ''
  }
}

async function batchRestartAccounts() {
  if (restartableSelectedAccounts.value.length === 0) {
    toast.warning('所选账号都未运行，无需批量重启')
    return
  }

  const skippedCount = Math.max(selectedAccounts.value.length - restartableSelectedAccounts.value.length, 0)
  let successCount = 0
  const failedNames: string[] = []
  try {
    batchLoading.value = true
    batchActionType.value = 'restart'
    for (const acc of restartableSelectedAccounts.value) {
      const id = String(acc?.id || '').trim()
      if (!id)
        continue
      try {
        await api.post(`/api/accounts/${id}/stop`)
        await api.post(`/api/accounts/${id}/start`)
        successCount += 1
      }
      catch (error) {
        console.error('批量重启失败:', error)
        failedNames.push(getAccountDisplayName(acc))
      }
    }
    try {
      await accountStore.fetchAccounts()
    }
    catch (error) {
      console.error('刷新账号列表失败:', error)
      toast.warning('批量重启已执行，但账号列表刷新失败，请手动刷新确认最新状态')
    }
    pushActionHistory({
      actionLabel: '批量重启',
      totalCount: restartableSelectedAccounts.value.length,
      successCount,
      failedNames,
      skippedCount,
      affectedNames: restartableSelectedAccounts.value.map(acc => getAccountDisplayName(acc)),
    })
    notifyBatchActionResult('批量重启', successCount, failedNames, skippedCount)
  }
  catch (e: any) {
    console.error(`批量重启失败: ${e.message}`)
    toast.error('批量重启失败，请稍后重试')
  }
  finally {
    batchLoading.value = false
    batchActionType.value = ''
  }
}

async function batchTransferOwnership() {
  if (!canBatchTransferOwnership.value)
    return

  const targetUsername = transferOwnershipTarget.value === UNOWNED_TRANSFER_VALUE ? null : transferOwnershipTarget.value
  const resolvedTransferTargetLabel = transferTargetLabel.value || (targetUsername ? String(targetUsername) : '未归属 / 系统账号')
  const targetAccounts = selectedAccounts.value.filter((acc) => {
    const currentOwner = String(acc?.username || '').trim()
    const nextOwner = String(targetUsername || '').trim()
    return currentOwner !== nextOwner
  })

  if (targetAccounts.length === 0) {
    toast.warning('所选账号已经属于当前目标归属，无需转移')
    return
  }

  const skippedCount = Math.max(selectedAccounts.value.length - targetAccounts.length, 0)
  let successCount = 0
  const failedNames: string[] = []
  try {
    transferLoading.value = true
    for (const acc of targetAccounts) {
      try {
        await api.post('/api/accounts', {
          id: String(acc.id || ''),
          username: targetUsername,
        })
        successCount += 1
      }
      catch (error) {
        console.error('批量转移归属失败:', error)
        failedNames.push(getAccountDisplayName(acc))
      }
    }
    transferOwnershipTarget.value = ''
    clearSelection()
    try {
      await initializePage()
    }
    catch (error) {
      console.error('刷新账号列表失败:', error)
      toast.warning('批量转移归属已执行，但账号列表刷新失败，请手动刷新确认最新状态')
    }
    pushActionHistory({
      actionLabel: '批量转移归属',
      totalCount: targetAccounts.length,
      successCount,
      failedNames,
      skippedCount,
      affectedNames: targetAccounts.map(acc => getAccountDisplayName(acc)),
      targetLabel: resolvedTransferTargetLabel,
    })
    notifyBatchActionResult('批量转移归属', successCount, failedNames, skippedCount)
  }
  catch (e: any) {
    console.error(`批量转移归属失败: ${e.message}`)
    toast.error('批量转移归属失败，请稍后重试')
  }
  finally {
    transferLoading.value = false
  }
}

async function bulkSetMode(mode: string) {
  if (selectedAccountIds.value.length === 0) {
    toast.warning('请先选择要批量设置的账号')
    return
  }
  const targetAccounts = selectedAccounts.value.filter(acc => resolveAccountMode(acc) !== mode)
  if (targetAccounts.length === 0) {
    toast.warning(`所选账号已经全部是${resolveModeMeta(mode).label}`)
    return
  }

  const skippedCount = Math.max(selectedAccounts.value.length - targetAccounts.length, 0)
  let successCount = 0
  const failedNames: string[] = []
  try {
    batchLoading.value = true
    batchActionType.value = `mode:${mode}`
    for (const acc of targetAccounts) {
      try {
        await api.post(`/api/accounts/${String(acc?.id || '').trim()}/mode`, { mode })
        successCount += 1
      }
      catch (error) {
        console.error('批量设置失败:', error)
        failedNames.push(getAccountDisplayName(acc))
      }
    }
    try {
      await accountStore.fetchAccounts()
    }
    catch (error) {
      console.error('刷新账号列表失败:', error)
      toast.warning('批量模式切换已执行，但账号列表刷新失败，请手动刷新确认最新状态')
    }
    pushActionHistory({
      actionLabel: `批量设为${resolveModeMeta(mode).label}`,
      totalCount: targetAccounts.length,
      successCount,
      failedNames,
      skippedCount,
      affectedNames: targetAccounts.map(acc => getAccountDisplayName(acc)),
      targetLabel: `目标模式：${resolveModeMeta(mode).label}`,
    })
    notifyBatchActionResult(`批量设为${resolveModeMeta(mode).label}`, successCount, failedNames, skippedCount)
  }
  catch (e: any) {
    console.error(`批量设置失败: ${e.message}`)
    toast.error('批量设置失败，请稍后重试')
  }
  finally {
    batchLoading.value = false
    batchActionType.value = ''
    clearSelection()
  }
}

function openBatchDeleteConfirm() {
  if (!canBatchDelete.value)
    return
  showBatchDeleteConfirm.value = true
}

async function confirmBatchDelete() {
  if (selectedAccounts.value.length === 0) {
    toast.warning('请先选择要删除的账号')
    return
  }
  const targetAccounts = [...selectedAccounts.value]
  let successCount = 0
  const failedNames: string[] = []
  try {
    batchDeleteLoading.value = true
    for (const acc of targetAccounts) {
      const id = String(acc.id || '').trim()
      if (!id)
        continue
      try {
        await api.delete(`/api/accounts/${id}`)
        successCount += 1
      }
      catch (error) {
        console.error('批量删除失败:', error)
        failedNames.push(getAccountDisplayName(acc))
      }
    }
    showBatchDeleteConfirm.value = false
    clearSelection()
    try {
      await initializePage()
    }
    catch (error) {
      console.error('刷新账号列表失败:', error)
      toast.warning('批量删除已执行，但账号列表刷新失败，请手动刷新确认最新状态')
    }
    pushActionHistory({
      actionLabel: '批量删除',
      totalCount: targetAccounts.length,
      successCount,
      failedNames,
      affectedNames: targetAccounts.map(acc => getAccountDisplayName(acc)),
    })
    notifyBatchActionResult('批量删除', successCount, failedNames)
  }
  catch (e: any) {
    console.error(`批量删除失败: ${e.message}`)
    toast.error('批量删除失败，请稍后重试')
  }
  finally {
    batchDeleteLoading.value = false
  }
}

function openSettings(account: any) {
  accountStore.selectAccount(String(account?.id || ''))
  router.push('/settings')
}

function openAddModal() {
  editingAccount.value = null
  showModal.value = true
}

function openEditModal(account: any) {
  editingAccount.value = { ...account }
  showModal.value = true
}

async function handleDelete(account: any) {
  accountToDelete.value = account
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (accountToDelete.value) {
    try {
      deleteLoading.value = true
      await accountStore.deleteAccount(accountToDelete.value.id)
      accountToDelete.value = null
      showDeleteConfirm.value = false
    }
    finally {
      deleteLoading.value = false
    }
  }
}

async function toggleAccount(account: any) {
  if (account.running) {
    await accountStore.stopAccount(String(account.id || ''))
  }
  else {
    await accountStore.startAccount(String(account.id || ''))
  }
}

async function handleSaved() {
  await initializePage()
}

async function handleModeChange(acc: any, mode: string) {
  try {
    await accountStore.updateAccountMode(acc.id, mode)
  }
  catch (e: any) {
    console.error(`切换模式失败: ${e.message}`)
  }
}

async function handleSafeCheck(acc: any) {
  // eslint-disable-next-line no-alert
  if (confirm(`是否分析 ${acc.name || acc.id} 的历史封禁日志并自动补充黑名单？`)) {
    try {
      safeCheckingId.value = acc.id
      await accountStore.applySafeModeBlacklist(acc.id)
    }
    catch (e: any) {
      console.error(`生成失败: ${e.message}`)
    }
    finally {
      safeCheckingId.value = ''
    }
  }
}

onMounted(() => {
  viewMode.value = readViewMode()
  readTableSortState()
  readTableColumnVisibility()
  readActionHistory()
  applyQueryState()
  initializePage()
})

watch(adminToken, (val) => {
  if (val) {
    initializePage()
  }
})

useIntervalFn(() => {
  accountStore.fetchAccounts()
}, 3000)
</script>

<template>
  <div class="mx-auto max-w-7xl w-full p-4">
    <div class="mb-6 space-y-4">
      <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0 flex-1 space-y-3">
          <div>
            <h1 class="text-2xl font-bold">
              账号管理
            </h1>
            <p class="glass-text-muted mt-1 text-sm">
              在一个页面里完成归属区分、搜索筛选、批量处理和账号状态查看。
            </p>
          </div>

          <div class="flex flex-wrap gap-2">
            <button
              v-for="tab in ownershipTabs"
              :key="tab.section"
              class="inline-flex items-center gap-2 border rounded-full px-4 py-2 text-sm font-semibold backdrop-blur-sm transition-all duration-200"
              :class="getOwnershipTabClasses(tab.section, ownershipFilter === tab.section)"
              @click="toggleOwnershipFilter(tab.section)"
            >
              <span>{{ tab.label }}</span>
              <span class="rounded-full bg-white/12 px-2 py-0.5 text-xs text-white/90">
                {{ tab.count }}
              </span>
            </button>
          </div>
        </div>

        <div class="flex flex-col items-start gap-3 xl:min-w-[360px] xl:items-end">
          <div class="flex flex-wrap gap-2 xl:justify-end">
            <button
              v-for="option in viewOptions"
              :key="option.value"
              class="inline-flex items-center gap-2 border rounded-full px-3.5 py-2 text-sm font-semibold transition-all duration-200"
              :class="viewMode === option.value ? 'border-white/20 bg-white/12 text-white shadow-[0_10px_30px_rgba(15,23,42,0.22)]' : 'border-white/8 bg-black/10 text-gray-300 hover:bg-white/8'"
              @click="setViewMode(option.value)"
            >
              <div class="text-sm" :class="[option.icon]" />
              {{ option.shortLabel }}
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <div class="text-sm text-gray-300/80">
              当前显示 <span class="text-white font-semibold">{{ filteredAccounts.length }}</span> / {{ accounts.length }} 个账号
            </div>
            <BaseButton
              variant="primary"
              @click="openAddModal"
            >
              <div class="i-carbon-add mr-2" />
              添加账号
            </BaseButton>
          </div>
        </div>
      </div>

      <div class="glass-panel rounded-2xl p-4 shadow-sm">
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.8fr)_repeat(3,minmax(0,0.9fr))]">
          <BaseInput
            v-model="searchKeyword"
            label="搜索账号"
            placeholder="搜索备注、UIN、归属用户名、平台"
            clearable
          />
          <BaseSelect
            v-model="platformFilter"
            label="平台筛选"
            :options="platformOptions"
          />
          <BaseSelect
            v-model="stateFilter"
            label="状态筛选"
            :options="stateOptions"
          />
          <BaseSelect
            v-model="sortMode"
            label="排序方式"
            :options="sortOptions"
          />
        </div>

        <div class="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div class="flex flex-wrap gap-2 text-xs">
            <span class="border border-white/10 rounded-full bg-black/10 px-3 py-1 text-gray-300">
              归属：{{ currentOwnershipLabel }}
            </span>
            <span class="border border-white/10 rounded-full bg-black/10 px-3 py-1 text-gray-300">
              平台：{{ platformOptions.find(item => item.value === platformFilter)?.label || '全部平台' }}
            </span>
            <span class="border border-white/10 rounded-full bg-black/10 px-3 py-1 text-gray-300">
              状态：{{ stateOptions.find(item => item.value === stateFilter)?.label || '全部状态' }}
            </span>
            <span class="border border-white/10 rounded-full bg-black/10 px-3 py-1 text-gray-300">
              视图：{{ currentViewLabel }}
            </span>
          </div>
          <div class="flex flex-wrap items-center self-start gap-2 lg:self-auto">
            <BaseButton
              variant="ghost"
              size="sm"
              class="border border-white/10 rounded-full bg-black/10 text-xs text-gray-200 hover:bg-white/8 !px-3"
              @click="copyCurrentFilterLink"
            >
              <div class="i-carbon-link mr-1 text-sm" />
              复制当前筛选链接
            </BaseButton>
            <BaseButton
              v-if="hasActiveFilters"
              variant="ghost"
              size="sm"
              class="!px-3"
              @click="clearFilters"
            >
              <div class="i-carbon-clean mr-1" />
              清空筛选
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <div v-if="accounts.length > 0" class="glass-panel mb-4 flex flex-col gap-3 rounded-lg p-3 shadow-sm xl:flex-row xl:items-center xl:justify-between">
      <div class="flex flex-wrap items-center gap-2">
        <BaseButton
          size="sm"
          class="border-0 from-blue-500 to-blue-600 bg-gradient-to-r text-xs text-white font-bold shadow-blue-500/25 shadow-md transition-all hover:from-blue-600 hover:to-blue-700 !px-4 !py-1.5 dark:shadow-blue-500/40 hover:shadow-blue-500/40 hover:shadow-lg"
          :disabled="filteredAccounts.length === 0"
          @click="selectAll"
        >
          <div class="i-carbon-checkmark-outline mr-1.5 text-sm" /> 全选
        </BaseButton>
        <BaseButton
          size="sm"
          class="border border-gray-300/50 bg-black/5 text-xs font-bold transition-all dark:bg-white/5 hover:bg-black/10 !px-4 !py-1.5 dark:hover:bg-white/10"
          :disabled="filteredAccounts.length === 0"
          @click="invertSelection"
        >
          反选
        </BaseButton>
        <BaseButton
          size="sm"
          class="border-0 from-red-500 to-red-600 bg-gradient-to-r text-xs text-white font-bold shadow-md shadow-red-500/25 transition-all hover:from-red-600 hover:to-red-700 !px-4 !py-1.5 dark:shadow-red-500/40 hover:shadow-lg hover:shadow-red-500/40"
          :disabled="selectedAccountIds.length === 0"
          @click="clearSelection"
        >
          <div class="i-carbon-close-outline mr-1.5 text-sm" /> 清空
        </BaseButton>

        <span class="glass-text-muted ml-1 text-xs font-medium">
          已选 {{ selectedAccountIds.length }} 项，当前筛选 {{ filteredAccounts.length }} 项
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div v-if="isAdmin" class="min-w-[220px]">
          <BaseSelect
            v-model="transferOwnershipTarget"
            label="批量转移归属"
            :options="ownershipTransferOptions"
            placeholder="选择目标归属账号"
          />
        </div>
        <BaseButton
          v-if="isAdmin"
          variant="secondary"
          size="sm"
          :disabled="!canBatchTransferOwnership || transferLoading"
          class="text-xs transition-opacity !border-violet-500/20 !bg-violet-500/10 !text-violet-200 hover:!bg-violet-500/20"
          :class="!canBatchTransferOwnership ? 'opacity-50' : 'opacity-100'"
          :title="transferTargetLabel ? `转移到 ${transferTargetLabel}` : '请先选择目标归属账号'"
          @click="batchTransferOwnership"
        >
          <div v-if="transferLoading" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-user-admin mr-1 text-sm" />
          转移归属
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="selectedAccountIds.length === 0 || batchLoading"
          class="text-xs transition-opacity !border-primary-500/20 !bg-primary-500/10 !text-primary-100 hover:!bg-primary-500/20"
          :class="selectedAccountIds.length === 0 ? 'opacity-50' : 'opacity-100'"
          @click="bulkSetMode('main')"
        >
          <div v-if="batchActionType === 'mode:main'" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-star-filled mr-1 text-sm" />
          批量设为主号
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="startableSelectedAccounts.length === 0 || batchLoading"
          class="text-xs transition-opacity !border-blue-500/20 !bg-blue-500/10 !text-blue-200 hover:!bg-blue-500/20"
          :class="startableSelectedAccounts.length === 0 ? 'opacity-50' : 'opacity-100'"
          @click="batchToggleAccounts('start')"
        >
          <div v-if="batchActionType === 'start'" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-play-filled mr-1 text-sm" />
          批量启动
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="stoppableSelectedAccounts.length === 0 || batchLoading"
          class="text-xs transition-opacity !border-orange-500/20 !bg-orange-500/10 !text-orange-200 hover:!bg-orange-500/20"
          :class="stoppableSelectedAccounts.length === 0 ? 'opacity-50' : 'opacity-100'"
          @click="batchToggleAccounts('stop')"
        >
          <div v-if="batchActionType === 'stop'" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-stop-filled mr-1 text-sm" />
          批量停止
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="restartableSelectedAccounts.length === 0 || batchLoading"
          class="text-xs transition-opacity !border-cyan-500/20 !bg-cyan-500/10 !text-cyan-200 hover:!bg-cyan-500/20"
          :class="restartableSelectedAccounts.length === 0 ? 'opacity-50' : 'opacity-100'"
          @click="batchRestartAccounts"
        >
          <div v-if="batchActionType === 'restart'" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-renew mr-1 text-sm" />
          批量重启
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="selectedAccountIds.length === 0 || batchLoading"
          class="text-xs transition-opacity"
          :class="selectedAccountIds.length === 0 ? 'opacity-50' : 'opacity-100'"
          @click="bulkSetMode('alt')"
        >
          <div v-if="batchActionType === 'mode:alt'" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-copy mr-1 text-sm" />
          批量设为小号
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="selectedAccountIds.length === 0 || batchLoading"
          class="text-xs transition-opacity !border-emerald-500/20 !bg-emerald-500/10 !text-emerald-600 hover:!bg-emerald-500/20 dark:!text-emerald-400"
          :class="selectedAccountIds.length === 0 ? 'opacity-50' : 'opacity-100'"
          @click="bulkSetMode('safe')"
        >
          <div v-if="batchActionType === 'mode:safe'" class="i-svg-spinners-ring-resize mr-1 text-sm" />
          <div v-else class="i-carbon-security mr-1 text-sm" />
          批量设为风险规避
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          class="border border-white/10 rounded-full bg-black/10 text-xs text-gray-200 hover:bg-white/8"
          :disabled="displayAccounts.length === 0"
          :loading="exportLoading && exportScope === 'all'"
          @click="exportAccounts('all')"
        >
          <div v-if="!(exportLoading && exportScope === 'all')" class="i-carbon-document-export mr-1 text-sm" />
          导出当前结果
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          class="border border-white/10 rounded-full bg-black/10 text-xs text-gray-200 hover:bg-white/8"
          :disabled="selectedAccounts.length === 0 || exportLoading"
          :loading="exportLoading && exportScope === 'selected'"
          @click="exportAccounts('selected')"
        >
          <div v-if="!(exportLoading && exportScope === 'selected')" class="i-carbon-export mr-1 text-sm" />
          导出已选
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          class="border border-red-500/20 rounded-full bg-red-500/8 text-xs text-red-300 hover:bg-red-500/14"
          :disabled="!canBatchDelete || batchDeleteLoading"
          @click="openBatchDeleteConfirm"
        >
          <div class="i-carbon-trash-can mr-1 text-sm" />
          批量删除
        </BaseButton>
      </div>
    </div>

    <div v-if="accounts.length > 0" class="glass-panel mb-4 rounded-[24px] p-4 shadow-sm">
      <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-base font-semibold">
              最近操作结果
            </h3>
            <span class="border border-white/8 rounded-full bg-black/10 px-3 py-1 text-xs text-gray-300">
              最近保留 {{ actionHistoryCount }} 条
            </span>
            <span
              v-if="latestActionHistory"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
              :class="getActionHistoryStatusMeta(latestActionHistory.status).badge"
            >
              <div :class="getActionHistoryStatusMeta(latestActionHistory.status).icon" />
              {{ getActionHistoryStatusMeta(latestActionHistory.status).label }}
            </span>
          </div>

          <div v-if="latestActionHistory" class="mt-4 space-y-3">
            <div class="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div class="min-w-0">
                <div class="line-clamp-1 text-lg font-semibold">
                  {{ latestActionHistory.actionLabel }}
                </div>
                <p class="glass-text-muted mt-1 text-sm">
                  {{ buildActionResultMessage(latestActionHistory.actionLabel, latestActionHistory.successCount, latestActionHistory.failedNames, latestActionHistory.skippedCount) }}
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-xs text-gray-300">
                <span class="border border-white/8 rounded-full bg-black/10 px-3 py-1">
                  {{ formatActionTime(latestActionHistory.timestamp) }}
                </span>
                <span class="border border-white/8 rounded-full bg-black/10 px-3 py-1">
                  {{ formatDateTime(latestActionHistory.timestamp) }}
                </span>
              </div>
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div class="border border-white/8 rounded-2xl bg-black/10 p-3.5">
                <div class="text-[11px] text-gray-400 tracking-[0.18em] uppercase">
                  涉及账号
                </div>
                <div class="mt-3 text-2xl font-semibold">
                  {{ latestActionHistory.totalCount }}
                </div>
                <div class="glass-text-muted mt-2 text-xs">
                  {{ latestActionHistory.affectedNames.join('、') || '暂无名称预览' }}
                </div>
              </div>
              <div class="border border-white/8 rounded-2xl bg-black/10 p-3.5">
                <div class="text-[11px] text-gray-400 tracking-[0.18em] uppercase">
                  执行结果
                </div>
                <div class="mt-3 flex flex-wrap gap-2 text-xs">
                  <span class="rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-300">成功 {{ latestActionHistory.successCount }}</span>
                  <span class="rounded-full bg-red-500/10 px-2.5 py-1 text-red-300">失败 {{ latestActionHistory.failedCount }}</span>
                  <span class="rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-300">跳过 {{ latestActionHistory.skippedCount }}</span>
                </div>
                <div class="glass-text-muted mt-2 text-xs leading-5">
                  {{ latestActionHistory.failedNames.length > 0 ? `失败账号：${latestActionHistory.failedNames.join('、')}` : '最近一次执行没有失败账号。' }}
                </div>
              </div>
              <div class="border border-white/8 rounded-2xl bg-black/10 p-3.5">
                <div class="text-[11px] text-gray-400 tracking-[0.18em] uppercase">
                  附加信息
                </div>
                <div class="mt-3 text-sm font-semibold leading-6">
                  {{ latestActionHistory.targetLabel || '无附加说明' }}
                </div>
                <div class="glass-text-muted mt-2 text-xs leading-5">
                  可用于回看最近一次批量处理的目标、范围和结果摘要。
                </div>
              </div>
            </div>
          </div>

          <div v-else class="mt-4 border border-white/10 rounded-2xl border-dashed bg-black/8 px-4 py-5 text-sm text-gray-300">
            最近操作历史会记录在这里。执行批量启动、重启、导出、转移归属或批量删除后，可以直接回看结果摘要。
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 xl:justify-end">
          <BaseButton
            variant="ghost"
            size="sm"
            class="border border-white/10 rounded-full bg-black/10 text-xs text-gray-200 hover:bg-white/8"
            :disabled="!latestActionHistory"
            @click="copyLatestActionSummary"
          >
            <div class="i-carbon-copy-file mr-1 text-sm" />
            复制最近摘要
          </BaseButton>
          <BaseButton
            variant="ghost"
            size="sm"
            class="border border-red-500/20 rounded-full bg-red-500/8 text-xs text-red-300 hover:bg-red-500/14"
            :disabled="actionHistoryCount === 0"
            @click="clearActionHistory"
          >
            <div class="i-carbon-clean mr-1 text-sm" />
            清空记录
          </BaseButton>
        </div>
      </div>

      <div v-if="recentActionHistory.length > 0" class="grid grid-cols-1 mt-4 gap-3 2xl:grid-cols-4 lg:grid-cols-2">
        <button
          v-for="item in recentActionHistory"
          :key="item.id"
          class="min-h-[166px] flex flex-col border rounded-2xl px-4 py-3 text-left transition-all hover:shadow-lg hover:-translate-y-0.5"
          :class="getActionHistoryStatusMeta(item.status).accent"
          @click="copyText(buildHistorySummaryText(item), '操作摘要已复制')"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="line-clamp-1 text-sm font-semibold">
                {{ item.actionLabel }}
              </div>
              <div class="mt-1 text-xs opacity-80">
                {{ formatActionTime(item.timestamp) }}
              </div>
            </div>
            <div class="text-base" :class="getActionHistoryStatusMeta(item.status).icon" />
          </div>
          <p class="line-clamp-3 mt-3 text-xs leading-5 opacity-90">
            {{ buildActionResultMessage(item.actionLabel, item.successCount, item.failedNames, item.skippedCount) }}
          </p>
          <div class="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span class="rounded-full bg-black/15 px-2.5 py-1">总计 {{ item.totalCount }}</span>
            <span class="rounded-full bg-black/15 px-2.5 py-1">成功 {{ item.successCount }}</span>
            <span class="rounded-full bg-black/15 px-2.5 py-1">失败 {{ item.failedCount }}</span>
          </div>
          <div class="mt-auto pt-3 text-[11px] opacity-75">
            {{ item.targetLabel || '点击复制本次摘要' }}
          </div>
        </button>
      </div>
    </div>

    <div v-if="loading && accounts.length === 0" class="glass-panel min-h-[300px] flex flex-col items-center justify-center rounded-lg py-12 text-center shadow">
      <div class="relative mb-6">
        <div class="i-svg-spinners-ring-resize text-5xl text-primary-500" />
        <div class="absolute inset-0 animate-ping rounded-full bg-primary-400/20 blur-xl" />
      </div>
      <h3 class="text-lg font-semibold tracking-tight">
        正在同步云端账号...
      </h3>
      <p class="glass-text-muted mt-2 text-sm">
        正在为您的容器分配安全资源，请稍候
      </p>
    </div>

    <div v-else-if="accounts.length === 0" class="glass-panel rounded-lg py-12 text-center shadow">
      <div i-carbon-user-avatar class="glass-text-muted mb-4 inline-block text-4xl" />
      <p class="glass-text-muted mb-4">
        暂无账号
      </p>
      <BaseButton
        variant="text"
        @click="openAddModal"
      >
        立即添加
      </BaseButton>
    </div>

    <div v-else-if="filteredAccounts.length === 0" class="glass-panel rounded-2xl py-14 text-center shadow">
      <div class="i-carbon-search-locate glass-text-muted mb-4 inline-block text-4xl" />
      <p class="text-base font-semibold">
        没有符合当前筛选条件的账号
      </p>
      <p class="glass-text-muted mt-2 text-sm">
        可以调整归属胶囊、搜索关键词或状态筛选，再继续查看。
      </p>
      <BaseButton
        variant="ghost"
        class="mt-4"
        @click="clearFilters"
      >
        清空筛选
      </BaseButton>
    </div>

    <div v-else-if="isTableView" class="glass-panel overflow-hidden rounded-[26px]">
      <div class="flex flex-col gap-3 border-b border-white/8 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 class="text-base font-semibold">
            表格视图
          </h3>
          <p class="glass-text-muted mt-1 text-sm">
            适合批量盘点账号归属、平台、最近登录时间和操作状态。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="border border-white/8 rounded-full bg-black/10 px-3 py-1.5 text-xs text-gray-300">
            当前排序：{{ currentTableSortLabel }}
          </div>
          <div class="border border-white/8 rounded-full bg-black/10 px-3 py-1.5 text-xs text-gray-300">
            当前筛选 {{ filteredAccounts.length }} 项，已选 {{ selectedAccountIds.length }} 项
          </div>
          <div class="relative" @click.stop>
            <BaseButton
              variant="ghost"
              size="sm"
              class="border border-white/10 rounded-full bg-black/10 text-xs text-gray-200 hover:bg-white/8"
              @click="showColumnSettings = !showColumnSettings"
            >
              <div class="i-carbon-column mr-1 text-sm" />
              列设置
            </BaseButton>
            <div
              v-if="showColumnSettings"
              class="glass-panel absolute right-0 top-[calc(100%+8px)] z-20 min-w-[220px] border border-white/10 rounded-2xl p-3 shadow-2xl"
            >
              <div class="mb-2 text-xs text-gray-400 tracking-[0.18em] uppercase">
                表格列显隐
              </div>
              <button
                v-for="column in tableColumnOptions"
                :key="column.key"
                class="w-full flex items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors hover:bg-white/6"
                @click="toggleTableColumn(column.key)"
              >
                <span>{{ column.label }}</span>
                <span
                  class="h-5 w-5 flex items-center justify-center rounded-full text-xs"
                  :class="visibleTableColumns[column.key] ? 'bg-primary-500/20 text-primary-200' : 'bg-black/20 text-gray-500'"
                >
                  <div :class="visibleTableColumns[column.key] ? 'i-carbon-checkmark' : 'i-carbon-subtract'" />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="max-h-[68vh] overflow-auto">
        <table class="min-w-[1260px] w-full text-sm">
          <thead class="sticky top-0 z-10 bg-[rgba(48,14,32,0.96)] text-left text-[11px] text-gray-400 tracking-[0.18em] uppercase backdrop-blur-md">
            <tr>
              <th class="px-4 py-3 font-medium">
                选择
              </th>
              <th class="px-4 py-3 font-medium">
                <button class="inline-flex items-center gap-1.5 transition-colors hover:text-white" @click="toggleTableSort('account')">
                  账号
                  <div class="text-xs" :class="getTableSortIcon('account')" />
                </button>
              </th>
              <th v-if="visibleTableColumns.owner" class="px-4 py-3 font-medium">
                <button class="inline-flex items-center gap-1.5 transition-colors hover:text-white" @click="toggleTableSort('owner')">
                  归属
                  <div class="text-xs" :class="getTableSortIcon('owner')" />
                </button>
              </th>
              <th v-if="visibleTableColumns.platform" class="px-4 py-3 font-medium">
                <button class="inline-flex items-center gap-1.5 transition-colors hover:text-white" @click="toggleTableSort('platform')">
                  平台 / 区服
                  <div class="text-xs" :class="getTableSortIcon('platform')" />
                </button>
              </th>
              <th v-if="visibleTableColumns.activity" class="px-4 py-3 font-medium">
                <button class="inline-flex items-center gap-1.5 transition-colors hover:text-white" @click="toggleTableSort('activity')">
                  最近登录
                  <div class="text-xs" :class="getTableSortIcon('activity')" />
                </button>
              </th>
              <th v-if="visibleTableColumns.mode" class="px-4 py-3 font-medium">
                <button class="inline-flex items-center gap-1.5 transition-colors hover:text-white" @click="toggleTableSort('mode')">
                  模式
                  <div class="text-xs" :class="getTableSortIcon('mode')" />
                </button>
              </th>
              <th v-if="visibleTableColumns.state" class="px-4 py-3 font-medium">
                <button class="inline-flex items-center gap-1.5 transition-colors hover:text-white" @click="toggleTableSort('state')">
                  状态
                  <div class="text-xs" :class="getTableSortIcon('state')" />
                </button>
              </th>
              <th v-if="visibleTableColumns.actions" class="px-4 py-3 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="acc in tableAccounts"
              :key="acc.id"
              class="cursor-pointer border-t border-white/8 align-top transition-colors hover:bg-white/[0.03]"
              :class="String(acc.id || '') === String(accountStore.currentAccountId || '') ? 'bg-primary-500/[0.05]' : ''"
              @click="accountStore.selectAccount(String(acc.id || ''))"
            >
              <td class="px-4 py-4 align-top">
                <div
                  class="h-5 w-5 flex cursor-pointer items-center justify-center border rounded transition-colors"
                  :class="isSelected(acc.id) ? 'bg-primary-500 border-primary-500' : 'border-gray-300/50 bg-black/5 dark:border-gray-600 dark:bg-white/5'"
                  @click.stop="toggleSelection(acc.id)"
                >
                  <div v-if="isSelected(acc.id)" class="i-carbon-checkmark text-white" />
                </div>
              </td>
              <td class="px-4 py-4 align-top">
                <div class="min-w-[220px] flex items-start gap-3">
                  <div class="h-11 w-11 flex shrink-0 items-center justify-center overflow-hidden border border-white/10 rounded-xl bg-black/10">
                    <img v-if="getAvatarUrl(acc)" :src="getAvatarUrl(acc)" class="h-full w-full object-cover" @error="(e) => markFailed((e.target as HTMLImageElement).src)">
                    <div v-else class="i-carbon-user glass-text-muted text-2xl" />
                  </div>
                  <div class="min-w-0">
                    <div class="line-clamp-1 text-base font-semibold">
                      {{ getAccountDisplayName(acc) }}
                    </div>
                    <div class="glass-text-muted line-clamp-1 mt-1 text-xs">
                      {{ getAccountSubline(acc) }}
                    </div>
                    <div class="glass-text-muted line-clamp-1 mt-1 text-xs">
                      昵称：{{ acc.nick || '暂无昵称' }}
                    </div>
                  </div>
                </div>
              </td>
              <td v-if="visibleTableColumns.owner" class="px-4 py-4 align-top">
                <div class="min-w-[180px]">
                  <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveOwnerMeta(acc).badge">
                    {{ resolveOwnerMeta(acc).shortLabel }}
                  </span>
                  <div class="line-clamp-2 mt-2 text-sm font-semibold leading-6">
                    {{ resolveOwnerMeta(acc).ownerText }}
                  </div>
                </div>
              </td>
              <td v-if="visibleTableColumns.platform" class="px-4 py-4 align-top">
                <div class="min-w-[140px]">
                  <div class="text-sm font-semibold">
                    {{ resolvePlatformLabel(acc.platform) }}
                  </div>
                  <div class="glass-text-muted mt-2 text-xs">
                    {{ resolveZoneLabel(acc) }}
                  </div>
                </div>
              </td>
              <td v-if="visibleTableColumns.activity" class="px-4 py-4 align-top">
                <div class="min-w-[168px]">
                  <div class="text-sm font-semibold leading-6">
                    {{ getLastLoginLabel(acc) }}
                  </div>
                  <div class="glass-text-muted mt-2 text-xs leading-5">
                    首次录入 {{ formatDateTime(acc.createdAt) }}
                  </div>
                </div>
              </td>
              <td v-if="visibleTableColumns.mode" class="px-4 py-4 align-top">
                <div class="min-w-[188px]">
                  <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveModeMeta(resolveAccountMode(acc)).badge">
                    {{ resolveModeMeta(resolveAccountMode(acc)).label }}
                  </span>
                  <div v-if="resolveModeExecutionMeta(acc)" class="mt-2 flex flex-wrap items-center gap-2">
                    <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveModeExecutionMeta(acc)?.badge">
                      {{ resolveModeExecutionMeta(acc)?.label }}
                    </span>
                  </div>
                  <div v-if="resolveModeExecutionMeta(acc)?.note" class="mt-2 text-xs leading-5" :class="resolveModeExecutionMeta(acc)?.noteClass">
                    {{ resolveModeExecutionMeta(acc)?.note }}
                  </div>
                  <div class="mt-3 flex items-center gap-0.5 border border-gray-200/50 rounded-full bg-black/[0.04] p-1 shadow-inner dark:border-gray-700/50 dark:bg-white/[0.03]" @click.stop>
                    <button
                      class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-all"
                      :class="getModeButtonClasses(acc, 'main')"
                      title="设为主号"
                      @click="handleModeChange(acc, 'main')"
                    >
                      主号
                    </button>
                    <button
                      class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-all"
                      :class="getModeButtonClasses(acc, 'alt')"
                      title="设为小号"
                      @click="handleModeChange(acc, 'alt')"
                    >
                      小号
                    </button>
                    <button
                      class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-all"
                      :class="getModeButtonClasses(acc, 'safe')"
                      title="设为风险规避"
                      @click="handleModeChange(acc, 'safe')"
                    >
                      避险
                    </button>
                  </div>
                </div>
              </td>
              <td v-if="visibleTableColumns.state" class="px-4 py-4 align-top">
                <div class="min-w-[170px]">
                  <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveRuntimeState(acc).badge">
                    {{ resolveRuntimeState(acc).label }}
                  </span>
                  <div v-if="acc.wsError?.message" class="line-clamp-2 mt-2 border border-red-500/15 rounded-2xl bg-red-500/10 px-3 py-2 text-xs text-red-300 leading-5">
                    最近错误：{{ acc.wsError.message }}
                  </div>
                  <div v-else class="glass-text-muted mt-2 text-xs leading-5">
                    {{ String(acc.id || '') === String(accountStore.currentAccountId || '') ? '当前选中账号，可继续进入设置调整。' : '暂无异常记录。' }}
                  </div>
                </div>
              </td>
              <td v-if="visibleTableColumns.actions" class="px-4 py-4 align-top">
                <div class="min-w-[218px] space-y-3" @click.stop>
                  <div class="flex flex-wrap items-center gap-2">
                    <BaseButton
                      variant="secondary"
                      size="sm"
                      class="min-w-[84px] border rounded-full shadow-sm transition-all duration-500 ease-in-out active:scale-95"
                      :class="acc.running ? 'border-red-500/20 bg-red-500/10 text-red-600 hover:bg-red-500/20 focus:ring-red-500/50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20' : 'border-green-500/20 bg-green-500/10 text-green-600 hover:bg-green-500/20 focus:ring-green-500/50 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20'"
                      @click.stop="toggleAccount(acc)"
                    >
                      <div :class="acc.running ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'" class="mr-1" />
                      {{ acc.running ? '停止' : '启动' }}
                    </BaseButton>

                    <BaseButton
                      v-if="resolveAccountMode(acc) === 'safe'"
                      variant="ghost"
                      size="sm"
                      class="rounded-full bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 !px-3 !py-1.5 !text-xs dark:text-emerald-400"
                      title="一键分析封禁日志并加入黑名单"
                      :loading="safeCheckingId === acc.id"
                      @click.stop="handleSafeCheck(acc)"
                    >
                      <div class="i-carbon-security mr-1" />
                      防封扫描
                    </BaseButton>
                  </div>

                  <div class="flex items-center gap-2">
                    <BaseButton
                      variant="ghost"
                      class="border border-white/8 rounded-full bg-black/10 hover:bg-white/8 !p-2.5"
                      title="设置"
                      @click.stop="openSettings(acc)"
                    >
                      <div class="i-carbon-settings text-lg" />
                    </BaseButton>
                    <BaseButton
                      variant="ghost"
                      class="border border-white/8 rounded-full bg-black/10 hover:bg-white/8 !p-2.5"
                      title="编辑"
                      @click.stop="openEditModal(acc)"
                    >
                      <div class="i-carbon-edit text-lg" />
                    </BaseButton>
                    <BaseButton
                      variant="ghost"
                      class="border border-red-500/20 rounded-full bg-red-500/8 text-red-500 hover:bg-red-500/14 !p-2.5 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"
                      title="删除"
                      @click.stop="handleDelete(acc)"
                    >
                      <div class="i-carbon-trash-can text-lg" />
                    </BaseButton>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-else :class="cardGridClass">
      <div
        v-for="acc in filteredAccounts"
        :key="acc.id"
        class="glass-panel group relative h-full flex flex-col cursor-pointer overflow-hidden border shadow-[0_20px_60px_rgba(15,23,42,0.18)] transition-all duration-300"
        :class="[
          isCompactView ? 'min-h-[392px] rounded-[22px] p-4' : 'min-h-[452px] rounded-[26px] p-5',
          String(acc.id || '') === String(accountStore.currentAccountId || '') ? 'border-primary-500/55 bg-primary-500/[0.05] shadow-[0_0_28px_rgba(var(--color-primary-500),0.18)] dark:border-primary-400/50' : 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]',
          resolveOwnerMeta(acc).cardGlow,
        ]"
        @click="accountStore.selectAccount(String(acc.id || ''))"
      >
        <div class="pointer-events-none absolute inset-x-0 top-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.14),transparent_62%)] opacity-80" :class="isCompactView ? 'h-24' : 'h-30'" />

        <div class="relative flex items-start justify-between gap-4 pl-8" :class="isCompactView ? 'min-h-[104px]' : 'min-h-[124px]'">
          <div
            class="absolute left-0 top-1 h-5 w-5 flex cursor-pointer items-center justify-center border rounded transition-colors"
            :class="isSelected(acc.id) ? 'bg-primary-500 border-primary-500' : 'border-gray-300/50 bg-black/5 dark:border-gray-600 dark:bg-white/5'"
            @click.stop="toggleSelection(acc.id)"
          >
            <div v-if="isSelected(acc.id)" class="i-carbon-checkmark text-white" />
          </div>

          <div class="min-w-0 flex flex-1 items-start gap-4">
            <div class="flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-black/10 shadow-inner dark:bg-white/10" :class="isCompactView ? 'h-12 w-12 rounded-xl' : 'h-14 w-14 rounded-2xl'">
              <img v-if="getAvatarUrl(acc)" :src="getAvatarUrl(acc)" class="h-full w-full object-cover" @error="(e) => markFailed((e.target as HTMLImageElement).src)">
              <div v-else class="i-carbon-user glass-text-muted" :class="isCompactView ? 'text-2xl' : 'text-3xl'" />
            </div>
            <div class="min-w-0 flex-1 pt-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] uppercase"
                  :class="resolveOwnerMeta(acc).badge"
                >
                  {{ resolveOwnerMeta(acc).shortLabel }}
                </span>
                <span
                  class="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] uppercase"
                  :class="resolveRuntimeState(acc).badge"
                >
                  {{ resolveRuntimeState(acc).label }}
                </span>
              </div>
              <h3 class="line-clamp-1 mt-3 font-semibold leading-tight" :class="isCompactView ? 'text-lg' : 'text-xl'" :title="getAccountDisplayName(acc)">
                {{ getAccountDisplayName(acc) }}
              </h3>
              <div class="glass-text-muted mt-2 text-sm leading-5" :class="isCompactView ? 'min-h-[38px]' : 'min-h-[42px]'">
                <p class="line-clamp-1">
                  {{ getAccountSubline(acc) }}
                </p>
                <p class="line-clamp-1">
                  昵称：{{ acc.nick || '暂无昵称' }}
                </p>
              </div>
            </div>
          </div>

          <div class="flex shrink-0 flex-col items-end gap-2">
            <BaseButton
              variant="secondary"
              size="sm"
              class="border rounded-full shadow-sm transition-all duration-500 ease-in-out active:scale-95"
              :class="[
                isCompactView ? 'w-18' : 'w-21',
                acc.running ? 'border-red-500/20 bg-red-500/10 text-red-600 hover:bg-red-500/20 focus:ring-red-500/50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20' : 'border-green-500/20 bg-green-500/10 text-green-600 hover:bg-green-500/20 focus:ring-green-500/50 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20',
              ]"
              @click.stop="toggleAccount(acc)"
            >
              <div :class="acc.running ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'" class="mr-1" />
              {{ acc.running ? '停止' : '启动' }}
            </BaseButton>
          </div>
        </div>

        <div class="grid mt-5 gap-3 border-y border-white/8 py-4" :class="isCompactView ? 'grid-cols-2' : 'md:grid-cols-3'">
          <div class="border border-white/8 rounded-2xl bg-black/12 p-3.5 backdrop-blur-sm" :class="isCompactView ? 'min-h-[110px]' : 'min-h-[132px]'">
            <div class="flex items-center gap-2 text-[11px] text-gray-400 tracking-[0.18em] uppercase">
              <div class="i-carbon-user-avatar text-sm" />
              归属账号
            </div>
            <div class="mt-3 flex items-center gap-2">
              <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveOwnerMeta(acc).badge">
                {{ resolveOwnerMeta(acc).shortLabel }}
              </span>
            </div>
            <div class="line-clamp-2 mt-3 text-sm font-semibold leading-6">
              {{ resolveOwnerMeta(acc).ownerText }}
            </div>
          </div>

          <div class="border border-white/8 rounded-2xl bg-black/12 p-3.5 backdrop-blur-sm" :class="isCompactView ? 'min-h-[110px]' : 'min-h-[132px]'">
            <div class="flex items-center gap-2 text-[11px] text-gray-400 tracking-[0.18em] uppercase">
              <div class="i-carbon-mobile text-sm" />
              登录平台
            </div>
            <div class="mt-3 text-base font-semibold">
              {{ resolvePlatformLabel(acc.platform) }}
            </div>
            <div class="mt-2 text-xs text-gray-400 leading-5">
              {{ resolveZoneLabel(acc) }}
            </div>
          </div>

          <div class="border border-white/8 rounded-2xl bg-black/12 p-3.5 backdrop-blur-sm" :class="isCompactView ? 'col-span-2 min-h-[104px]' : 'min-h-[132px]'">
            <div class="flex items-center gap-2 text-[11px] text-gray-400 tracking-[0.18em] uppercase">
              <div class="i-carbon-time text-sm" />
              最后登录
            </div>
            <div class="mt-3 text-base font-semibold leading-6">
              {{ getLastLoginLabel(acc) }}
            </div>
            <div class="mt-2 text-xs text-gray-400 leading-5">
              首次录入 {{ formatDateTime(acc.createdAt) }}
            </div>
          </div>
        </div>

        <div class="mt-auto" :class="isCompactView ? 'pt-3' : 'pt-4'">
          <div class="min-h-[54px] flex flex-col gap-3" :class="isCompactView ? '' : 'xl:flex-row xl:items-start xl:justify-between'">
            <div class="min-w-0 flex-1">
              <div class="glass-text-muted flex flex-wrap items-center gap-2 text-sm">
                <span class="flex items-center gap-1.5 font-medium">
                  <div class="h-2 w-2 rounded-full" :class="resolveRuntimeState(acc).dot" />
                  {{ resolveRuntimeState(acc).label }}
                </span>
                <span class="border border-white/8 rounded-full bg-black/10 px-2.5 py-1 text-xs text-gray-300">
                  平台：{{ resolvePlatformLabel(acc.platform) }}
                </span>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveModeMeta(resolveAccountMode(acc)).badge">
                  配置: {{ resolveModeMeta(resolveAccountMode(acc)).label }}
                </span>
                <span v-if="resolveModeExecutionMeta(acc)" class="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold" :class="resolveModeExecutionMeta(acc)?.badge">
                  {{ resolveModeExecutionMeta(acc)?.label }}
                </span>
              </div>
              <p v-if="resolveModeExecutionMeta(acc)?.note" class="mt-2 text-xs leading-5" :class="resolveModeExecutionMeta(acc)?.noteClass">
                {{ resolveModeExecutionMeta(acc)?.note }}
              </p>
              <p v-if="!isCompactView && !acc.wsError?.message" class="mt-2 text-xs text-gray-400 leading-5">
                {{ String(acc.id || '') === String(accountStore.currentAccountId || '') ? '当前选中账号，可直接继续进入设置和策略调整。' : '最近没有异常记录，可继续执行批量操作或单账号管理。' }}
              </p>
            </div>
            <span
              v-if="acc.wsError?.message"
              class="max-w-full truncate border border-red-500/15 rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-300 xl:max-w-[260px]"
              :title="acc.wsError.message"
            >
              最近错误：{{ acc.wsError.message }}
            </span>
            <transition name="fade">
              <BaseButton
                v-if="resolveAccountMode(acc) === 'safe'"
                variant="ghost"
                size="sm"
                class="shrink-0 rounded-full bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 !px-3 !py-1.5 !text-xs dark:text-emerald-400"
                title="一键分析封禁日志并加入黑名单"
                :loading="safeCheckingId === acc.id"
                @click.stop="handleSafeCheck(acc)"
              >
                <div class="i-carbon-security mr-1" />
                防封扫描
              </BaseButton>
            </transition>
          </div>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-0.5 border border-gray-200/50 rounded-full bg-black/[0.04] p-1 shadow-inner dark:border-gray-700/50 dark:bg-white/[0.03]" @click.stop>
              <button
                class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-all"
                :class="getModeButtonClasses(acc, 'main')"
                title="设为主号"
                @click="handleModeChange(acc, 'main')"
              >
                主号
              </button>
              <button
                class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-all"
                :class="getModeButtonClasses(acc, 'alt')"
                title="设为小号"
                @click="handleModeChange(acc, 'alt')"
              >
                小号
              </button>
              <button
                class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-all"
                :class="getModeButtonClasses(acc, 'safe')"
                title="设为风险规避"
                @click="handleModeChange(acc, 'safe')"
              >
                避险
              </button>
            </div>

            <div class="flex items-center gap-2">
              <BaseButton
                variant="ghost"
                class="border border-white/8 rounded-full bg-black/10 hover:bg-white/8 !p-2.5"
                title="设置"
                @click.stop="openSettings(acc)"
              >
                <div class="i-carbon-settings text-lg" />
              </BaseButton>
              <BaseButton
                variant="ghost"
                class="border border-white/8 rounded-full bg-black/10 hover:bg-white/8 !p-2.5"
                title="编辑"
                @click.stop="openEditModal(acc)"
              >
                <div class="i-carbon-edit text-lg" />
              </BaseButton>
              <BaseButton
                variant="ghost"
                class="border border-red-500/20 rounded-full bg-red-500/8 text-red-500 hover:bg-red-500/14 !p-2.5 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"
                title="删除"
                @click.stop="handleDelete(acc)"
              >
                <div class="i-carbon-trash-can text-lg" />
              </BaseButton>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AccountModal
      :show="showModal"
      :edit-data="editingAccount"
      @close="showModal = false"
      @saved="handleSaved"
    />

    <ConfirmModal
      :show="showDeleteConfirm"
      :loading="deleteLoading"
      title="删除账号"
      :message="accountToDelete ? `确定要删除账号 ${accountToDelete.name || accountToDelete.id} 吗?` : ''"
      confirm-text="删除"
      type="danger"
      @close="!deleteLoading && (showDeleteConfirm = false)"
      @cancel="!deleteLoading && (showDeleteConfirm = false)"
      @confirm="confirmDelete"
    />

    <ConfirmModal
      :show="showBatchDeleteConfirm"
      :loading="batchDeleteLoading"
      title="批量删除账号"
      :message="batchDeleteMessage"
      confirm-text="确认批量删除"
      type="danger"
      @cancel="!batchDeleteLoading && (showBatchDeleteConfirm = false)"
      @confirm="confirmBatchDelete"
    />
  </div>
</template>
