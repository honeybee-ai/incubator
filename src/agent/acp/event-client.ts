import type { AcpClient } from '@agentcoordinationprotocol/sdk';

/**
 * Polls incubator for events between agent iterations.
 * Buffers events and formats them as context messages for the LLM.
 */
export class EventClient {
  private client: AcpClient;
  private cursor = 0;
  private agentId: string;

  constructor(client: AcpClient, agentId: string) {
    this.client = client;
    this.agentId = agentId;
  }

  /**
   * Poll for new events since last check.
   * Returns formatted context messages for injection into the conversation.
   */
  async drain(): Promise<string[]> {
    try {
      const res = await this.client.getEvents(this.cursor);
      if (!res.ok) return [];

      const data = res.data as unknown as {
        events: Array<{ type: string; data: unknown; agentId: string; seq: number }>;
        cursor: number;
      };

      if (!data.events || data.events.length === 0) return [];

      this.cursor = data.cursor;

      // Filter out our own events
      const otherEvents = data.events.filter(e => e.agentId !== this.agentId);
      if (otherEvents.length === 0) return [];

      // Format events as context messages
      return otherEvents.map(e => {
        const source = e.agentId;
        const payload = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
        return `Event from ${source}: [${e.type}] ${payload}`;
      });
    } catch {
      // Server unreachable — skip event polling
      return [];
    }
  }

  /**
   * Poll for messages addressed to this agent.
   */
  async drainMessages(): Promise<string[]> {
    try {
      const res = await this.client.getMessages();
      if (!res.ok) return [];

      const messages = res.data as unknown as Array<{
        from: string;
        content: string;
        createdAt: string;
      }>;

      if (!messages || messages.length === 0) return [];

      return messages.map(m => `Message from ${m.from}: ${m.content}`);
    } catch {
      return [];
    }
  }
}
