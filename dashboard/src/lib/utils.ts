import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Deterministic color from agent ID */
export function agentColor(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `oklch(0.7 0.15 ${hue})`
}

/** Deterministic short label from agent ID */
export function agentLabel(agentId: string): string {
  if (agentId.startsWith('agent_')) return agentId.slice(6, 10)
  if (agentId.startsWith('rest_')) return agentId.slice(5, 9)
  return agentId.slice(0, 4)
}

/** Format ISO timestamp to HH:MM:SS */
export function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

/** Format duration in seconds to human readable */
export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

/** Format relative time */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}
