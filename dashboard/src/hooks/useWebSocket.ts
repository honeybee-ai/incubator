import { useEffect, useRef } from 'react'
import { useDashboardStore } from '@/stores/dashboard'
import type { WsMessage } from '@/lib/types'

const RECONNECT_DELAY = 2000
const MAX_RECONNECT_DELAY = 30000

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(RECONNECT_DELAY)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ns = useDashboardStore((s) => s.activeNamespace)
  const setWsStatus = useDashboardStore((s) => s.setWsStatus)
  const addEvents = useDashboardStore((s) => s.addEvents)
  const setEventCursor = useDashboardStore((s) => s.setEventCursor)
  const setMetrics = useDashboardStore((s) => s.setMetrics)

  useEffect(() => {
    let closed = false

    function connect() {
      if (closed) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${window.location.host}/ws?namespace=${encodeURIComponent(ns)}&since=0`

      setWsStatus('connecting')
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setWsStatus('connected')
        reconnectDelay.current = RECONNECT_DELAY
      }

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as WsMessage
          switch (msg.type) {
            case 'event':
              addEvents([msg.event])
              break
            case 'replay_done':
              setEventCursor(msg.cursor)
              break
            case 'ping':
              // keepalive, no action
              break
            case 'metrics':
              setMetrics(msg.data)
              break
            case 'error':
              console.warn('[dashboard] WS error:', msg.message)
              break
          }
        } catch {
          // ignore malformed
        }
      }

      ws.onclose = () => {
        wsRef.current = null
        if (!closed) {
          setWsStatus('disconnected')
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, MAX_RECONNECT_DELAY)
            connect()
          }, reconnectDelay.current)
        }
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      closed = true
      clearTimeout(reconnectTimer.current)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setWsStatus('disconnected')
    }
  }, [ns, setWsStatus, addEvents, setEventCursor, setMetrics])
}
