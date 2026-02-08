import type { Message } from '../types.js';
import type { IMessageStore } from './interfaces.js';
import { randomBytes } from 'node:crypto';

export class MessageStore implements IMessageStore {
  private messages: Message[] = [];

  async send(from: string, to: string, content: string, replyTo?: string): Promise<Message> {
    const msg: Message = {
      id: randomBytes(8).toString('hex'),
      from,
      to,
      content,
      replyTo,
      sentAt: new Date().toISOString(),
    };
    this.messages.push(msg);
    return msg;
  }

  async getFor(agentId: string, since?: string): Promise<Message[]> {
    return this.messages.filter(m => {
      if (m.to !== agentId) return false;
      if (since && m.sentAt <= since) return false;
      return true;
    });
  }

  async getAll(): Promise<Message[]> {
    return [...this.messages];
  }
}
