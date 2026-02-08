import { useEffect, useRef, useCallback } from 'react'
import { useDashboardStore } from '@/stores/dashboard'
import * as api from '@/lib/api'

const POLL_INTERVAL = 5000

export function usePolling() {
  const ns = useDashboardStore((s) => s.activeNamespace)
  const setHealth = useDashboardStore((s) => s.setHealth)
  const setNamespaces = useDashboardStore((s) => s.setNamespaces)
  const setProtocol = useDashboardStore((s) => s.setProtocol)
  const setStateEntries = useDashboardStore((s) => s.setStateEntries)
  const setClaims = useDashboardStore((s) => s.setClaims)
  const setDiscoveries = useDashboardStore((s) => s.setDiscoveries)
  const setTeam = useDashboardStore((s) => s.setTeam)
  const setHelpRequests = useDashboardStore((s) => s.setHelpRequests)
  const setProgressReports = useDashboardStore((s) => s.setProgressReports)
  const setConflicts = useDashboardStore((s) => s.setConflicts)
  const setReinforcements = useDashboardStore((s) => s.setReinforcements)
  const setProposals = useDashboardStore((s) => s.setProposals)
  const initialLoad = useRef(false)

  const poll = useCallback(async () => {
    try {
      const [health, namespaces, state, claims, discoveries, roles, help, progress, conflicts, reinforcements, proposals] = await Promise.all([
        api.fetchHealth(ns),
        api.fetchNamespaces(),
        api.fetchState(ns),
        api.fetchClaims(ns),
        api.fetchDiscoveries(ns),
        api.fetchRoles(ns),
        api.fetchHelp(ns),
        api.fetchProgress(ns),
        api.fetchConflicts(ns),
        api.fetchReinforcements(ns),
        api.fetchProposals(ns),
      ])
      setHealth(health)
      setNamespaces(namespaces)
      setStateEntries(state)
      setClaims(claims)
      setDiscoveries(discoveries)
      setTeam(roles)
      setHelpRequests(help)
      setProgressReports(progress)
      setConflicts(conflicts)
      setReinforcements(reinforcements)
      setProposals(proposals)
    } catch {
      // Server likely not running — silent fail
    }
  }, [ns, setHealth, setNamespaces, setStateEntries, setClaims, setDiscoveries, setTeam, setHelpRequests, setProgressReports, setConflicts, setReinforcements, setProposals])

  // Load protocol once per namespace switch
  useEffect(() => {
    initialLoad.current = false
    api.fetchProtocol(ns).then(({ spec, team }) => {
      setProtocol(spec)
      if (team.length > 0) setTeam(team)
      initialLoad.current = true
    }).catch(() => {
      setProtocol(null)
      initialLoad.current = true
    })
  }, [ns, setProtocol, setTeam])

  // Poll interval
  useEffect(() => {
    poll()
    const timer = setInterval(poll, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [poll])
}
