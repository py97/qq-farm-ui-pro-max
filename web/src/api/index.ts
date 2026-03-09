import axios from 'axios'
import { useToastStore } from '@/stores/toast'
import { clearLocalAuthState, currentAccountId } from '@/utils/auth'

const api = axios.create({
  baseURL: '/',
  timeout: 10000,
  withCredentials: true,
})

api.interceptors.request.use((config) => {
  const accountId = String(currentAccountId.value || localStorage.getItem('current_account_id') || '').trim()
  if (accountId) {
    config.headers['x-account-id'] = accountId
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

let isRefreshing = false
let refreshSubscribers: Array<(ok: boolean) => void> = []

function onRefreshDone(ok: boolean) {
  refreshSubscribers.forEach(cb => cb(ok))
  refreshSubscribers = []
}

api.interceptors.response.use((response) => {
  return response
}, async (error) => {
  const toast = useToastStore()
  const originalRequest = error.config

  if (error.response?.status === 401 && !originalRequest._retry) {
    if (originalRequest.url?.includes('/auth/refresh') || originalRequest.url?.includes('/auth/logout')) {
      clearLocalAuthState()
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login'
        toast.warning('登录已过期，请重新登录')
      }
      return Promise.reject(error)
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshSubscribers.push((ok) => {
          if (ok) {
            originalRequest._retry = true
            resolve(api(originalRequest))
          }
          else {
            reject(error)
          }
        })
      })
    }

    isRefreshing = true
    originalRequest._retry = true

    try {
      await axios.post('/api/auth/refresh', {}, { withCredentials: true })
      onRefreshDone(true)
      return api(originalRequest)
    }
    catch {
      onRefreshDone(false)
      clearLocalAuthState()
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login'
        toast.warning('登录已过期，请重新登录')
      }
      return Promise.reject(error)
    }
    finally {
      isRefreshing = false
    }
  }

  if (error.response) {
    if (error.response.status >= 500) {
      const backendError = String(error.response.data?.error || error.response.data?.message || '')
      if (backendError === '账号未运行' || backendError === 'API Timeout') {
        return Promise.reject(error)
      }
      toast.error(`服务器错误: ${error.response.status} ${error.response.statusText}`)
    }
    else if (error.response.status !== 401) {
      const msg = error.response.data?.message || error.message
      toast.error(`请求失败: ${msg}`)
    }
  }
  else if (error.request) {
    toast.error('网络错误，无法连接到服务器')
  }
  else {
    toast.error(`错误: ${error.message}`)
  }

  return Promise.reject(error)
})

export default api
