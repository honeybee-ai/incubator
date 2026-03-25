import type { IEventStore } from './interfaces.js';

export interface HaltInfo {
  halted: true;
  reason: string;
  status: 'completed' | 'failed';
  haltedBy: string;
  haltedAt: string;
}

export interface PauseInfo {
  paused: true;
  reason: string;
  pausedBy: string;
  pausedAt: string;
}

export interface ControlStatus {
  halted: boolean;
  paused: boolean;
  haltReason?: string;
  haltStatus?: string;
  pauseReason?: string;
}

export class ControlStore {
  private protocolHalt: HaltInfo | null = null;
  private agentHalts = new Map<string, HaltInfo>();
  private protocolPause: PauseInfo | null = null;
  private agentPauses = new Map<string, PauseInfo>();
  private events: IEventStore;

  constructor(events: IEventStore) {
    this.events = events;
  }

  /** Halt the entire protocol or a specific agent */
  async halt(reason: string, haltedBy: string, status: 'completed' | 'failed' = 'completed', target?: string): Promise<HaltInfo> {
    const info: HaltInfo = {
      halted: true,
      reason,
      status,
      haltedBy,
      haltedAt: new Date().toISOString(),
    };

    if (target) {
      this.agentHalts.set(target, info);
      await this.events.publish('honeybee.agent.halted', { agent: target, reason, status, halted_by: haltedBy }, haltedBy);
    } else {
      this.protocolHalt = info;
      await this.events.publish('protocol.halt', { reason, status, halted_by: haltedBy }, haltedBy);
    }

    return info;
  }

  /** Pause the entire protocol or a specific agent */
  async pause(reason: string, pausedBy: string, target?: string): Promise<PauseInfo> {
    const info: PauseInfo = {
      paused: true,
      reason,
      pausedBy,
      pausedAt: new Date().toISOString(),
    };

    if (target) {
      this.agentPauses.set(target, info);
      await this.events.publish('honeybee.agent.paused', { agent: target, reason, paused_by: pausedBy }, pausedBy);
    } else {
      this.protocolPause = info;
      await this.events.publish('protocol.paused', { reason, paused_by: pausedBy }, pausedBy);
    }

    return info;
  }

  /** Resume a specific agent or the entire protocol */
  async resume(resumedBy: string, reason: string, target?: string): Promise<boolean> {
    if (target) {
      if (!this.agentPauses.has(target)) return false;
      this.agentPauses.delete(target);
      await this.events.publish('honeybee.agent.resumed', { agent: target, reason, resumed_by: resumedBy }, resumedBy);
      return true;
    } else {
      if (!this.protocolPause) return false;
      this.protocolPause = null;
      await this.events.publish('protocol.resumed', { reason, resumed_by: resumedBy }, resumedBy);
      return true;
    }
  }

  /** Check if an agent should stop (halted) or wait (paused) */
  getStatus(agentId?: string): ControlStatus {
    // Protocol-wide halt takes priority
    if (this.protocolHalt) {
      return {
        halted: true,
        paused: false,
        haltReason: this.protocolHalt.reason,
        haltStatus: this.protocolHalt.status,
      };
    }

    // Per-agent halt
    if (agentId && this.agentHalts.has(agentId)) {
      const h = this.agentHalts.get(agentId)!;
      return {
        halted: true,
        paused: false,
        haltReason: h.reason,
        haltStatus: h.status,
      };
    }

    // Protocol-wide pause
    if (this.protocolPause) {
      return {
        halted: false,
        paused: true,
        pauseReason: this.protocolPause.reason,
      };
    }

    // Per-agent pause
    if (agentId && this.agentPauses.has(agentId)) {
      const p = this.agentPauses.get(agentId)!;
      return {
        halted: false,
        paused: true,
        pauseReason: p.reason,
      };
    }

    return { halted: false, paused: false };
  }
}
