/**
 * Incubator Voice Plugin — ACP-native voice call integration.
 *
 * Bridges @honeybee-ai/voice events into ACP primitives:
 * - Human speech → ACP events (voice.human_said)
 * - Call state → ACP state keys (voice.status, voice.callSid)
 * - Phone line → ACP claim (voice:line mutex)
 * - Voice tools → waggle compound tool
 *
 * This is an internal incubator plugin, NOT an npm package.
 * It's created by the incubator server and given direct store access.
 */

import type {
  IncubatorPlugin,
  PluginContext,
  ToolEntry,
  ToolResult,
} from '@honeybee-ai/hivemind-sdk/integrations';
import type { IStateStore, IEventStore, IClaimStore } from '../stores/interfaces.js';

// ── Types ─────────────────────────────────────────────────────────

export interface VoicePluginConfig {
  twilio: {
    accountSid: string;
    authToken: string;
    phoneNumber: string;
  };
  /** Pre-built STT provider instance */
  sttProvider: { createStream: (config: unknown) => unknown };
  /** Pre-built TTS provider instance */
  ttsProvider: { synthesize: (text: string, config?: unknown) => Promise<Buffer> };
  /** Pre-existing public URL (no ngrok) */
  tunnelUrl?: string;
  /** ngrok domain */
  ngrokDomain?: string;
  /** Local port for Twilio webhooks */
  targetPort: number;
  /** Log directory for call transcripts */
  logDir?: string;
  /** Silence timeout ms */
  silenceTimeoutMs?: number;
  /** TTS voice name */
  voice?: string;
}

export interface VoicePluginStores {
  state: IStateStore;
  events: IEventStore;
  claims: IClaimStore;
}

// ── Helpers ─────────────────────────────────────────────────────

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ── Plugin factory ──────────────────────────────────────────────

/**
 * Create an incubator voice plugin.
 *
 * The plugin:
 * 1. Creates a VoiceService from @honeybee-ai/voice
 * 2. Wires VoiceService events → ACP state/events/claims
 * 3. Exposes voice_call, voice_speak, voice_hangup, voice_status tools
 * 4. Registers HTTP routes for Twilio webhooks (via registerRoutes)
 */
export function createVoicePlugin(
  config: VoicePluginConfig,
  stores: VoicePluginStores,
): IncubatorPlugin {
  // Dynamically imported VoiceService (avoids hard dep at module level).
  // Uses `any` because @honeybee-ai/voice is an optional runtime dep — same pattern as propolis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any = null;

  const AGENT_ID = 'voice-plugin';

  return {
    name: 'voice',

    async start(_ctx: PluginContext): Promise<void> {
      let VoiceService: any;
      try {
        const pkg = '@honeybee-ai/voice';
        const voiceMod = await import(/* webpackIgnore: true */ pkg);
        VoiceService = voiceMod.VoiceService;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        throw new Error(`Failed to load @honeybee-ai/voice: ${msg}. Install it: pnpm add @honeybee-ai/voice`);
      }

      service = new VoiceService({
        twilio: config.twilio,
        sttProvider: config.sttProvider,
        ttsProvider: config.ttsProvider,
        tunnelUrl: config.tunnelUrl,
        ngrokDomain: config.ngrokDomain,
        targetPort: config.targetPort,
        logDir: config.logDir,
        silenceTimeoutMs: config.silenceTimeoutMs,
        voice: config.voice,
      });

      await service.init();

      // ── ACP Auto-Sync ──────────────────────────────────────────

      // Human speech → ACP event + state
      service.on('human.said', (data: { text: string; callSid: string }) => {
        stores.events.publish('voice.human_said', { text: data.text, callSid: data.callSid }, AGENT_ID)
          .catch(() => { /* non-fatal */ });
        stores.state.set('voice.lastTranscript', data.text, AGENT_ID)
          .catch(() => { /* non-fatal */ });
      });

      // Call state → ACP state + events
      service.on('state', (data: { state: string; callSid?: string }) => {
        stores.state.set('voice.status', data.state, AGENT_ID)
          .catch(() => { /* non-fatal */ });

        if (data.callSid) {
          stores.state.set('voice.callSid', data.callSid, AGENT_ID)
            .catch(() => { /* non-fatal */ });
        }

        if (data.state === 'connected' && data.callSid) {
          stores.events.publish('voice.call_connected', { callSid: data.callSid }, AGENT_ID)
            .catch(() => { /* non-fatal */ });
        }

        if (data.state === 'ended' || data.state === 'error') {
          // Release phone line claim
          stores.claims.release('voice:line', AGENT_ID)
            .catch(() => { /* non-fatal */ });
          stores.events.publish('voice.call_ended', { callSid: data.callSid }, AGENT_ID)
            .catch(() => { /* non-fatal */ });
        }
      });

      // Transcript log → ACP state (JSON array)
      service.on('transcript', (data: { role: string; text: string; ts: number }) => {
        (async () => {
          const existing = await stores.state.get('voice.transcript');
          let arr: unknown[] = [];
          if (existing?.value) {
            try { arr = JSON.parse(String(existing.value)); } catch { /* ignore */ }
          }
          arr.push({ role: data.role, text: data.text, ts: data.ts });
          await stores.state.set('voice.transcript', JSON.stringify(arr), AGENT_ID);
        })().catch(() => { /* non-fatal */ });
      });

      console.error(`[voice] Plugin ready. Tunnel: ${service.tunnelUrl ?? 'none'}`);
    },

    async stop(): Promise<void> {
      if (service) {
        await service.destroy();
        service = null;
      }
    },

    getToolEntries(_ctx: PluginContext): ToolEntry[] {
      return [
        // ── voice_call ────────────────────────────────────────
        {
          def: {
            type: 'function',
            function: {
              name: 'voice_call',
              description: 'Place an outbound phone call. Claims voice:line mutex. Returns callSid on success.',
              parameters: {
                type: 'object',
                properties: {
                  to: { type: 'string', description: 'Phone number to call (E.164 format, e.g. +15551234567)' },
                  greeting: { type: 'string', description: 'Optional greeting to speak when call connects' },
                },
                required: ['to'],
              },
            },
          },
          schema: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              greeting: { type: 'string' },
            },
            required: ['to'],
          },
          handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
            if (!service) return textResult('Voice plugin not initialized');

            const to = String(args.to ?? '');
            const greeting = args.greeting ? String(args.greeting) : undefined;

            if (!to) return textResult('Error: phone number (to) is required');

            // Validate E.164 format
            if (!/^\+[1-9]\d{1,14}$/.test(to)) {
              return textResult('Error: phone number must be in E.164 format (e.g. +15551234567)');
            }

            // Claim the phone line
            const claimed = await stores.claims.claim('voice:line', 'active call', AGENT_ID);
            if (claimed.status !== 'approved') {
              return textResult('Error: phone line already claimed by another agent');
            }

            try {
              const callSid = await service.call(to, greeting);
              await stores.events.publish('voice.call_initiated', { to, callSid }, AGENT_ID);
              return jsonResult({ callSid, status: 'ringing' });
            } catch (err) {
              await stores.claims.release('voice:line', AGENT_ID).catch(() => {});
              return textResult(`Error: ${err instanceof Error ? err.message : 'call failed'}`);
            }
          },
        },

        // ── voice_speak ───────────────────────────────────────
        {
          def: {
            type: 'function',
            function: {
              name: 'voice_speak',
              description: 'Speak text on the active phone call via TTS. The caller will hear the spoken text.',
              parameters: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Text to speak on the call' },
                },
                required: ['text'],
              },
            },
          },
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
          handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
            if (!service) return textResult('Voice plugin not initialized');

            const text = String(args.text ?? '');
            if (!text) return textResult('Error: text is required');

            try {
              await service.speak(text);
              await stores.state.set('voice.lastSpoken', text, AGENT_ID);
              await stores.events.publish('voice.agent_spoke', { text }, AGENT_ID);
              return jsonResult({ spoken: true });
            } catch (err) {
              return textResult(`Error: ${err instanceof Error ? err.message : 'speak failed'}`);
            }
          },
        },

        // ── voice_hangup ──────────────────────────────────────
        {
          def: {
            type: 'function',
            function: {
              name: 'voice_hangup',
              description: 'End the active phone call and release the line.',
              parameters: {
                type: 'object',
                properties: {},
                required: [],
              },
            },
          },
          schema: {
            type: 'object',
            properties: {},
          },
          handler: async (): Promise<ToolResult> => {
            if (!service) return textResult('Voice plugin not initialized');

            try {
              await service.hangup();
              // State cleanup happens in the 'state' event handler
              return jsonResult({ hungUp: true });
            } catch (err) {
              return textResult(`Error: ${err instanceof Error ? err.message : 'hangup failed'}`);
            }
          },
        },

        // ── voice_status ──────────────────────────────────────
        {
          def: {
            type: 'function',
            function: {
              name: 'voice_status',
              description: 'Get current voice call state from ACP state.',
              parameters: {
                type: 'object',
                properties: {},
                required: [],
              },
            },
          },
          schema: {
            type: 'object',
            properties: {},
          },
          handler: async (): Promise<ToolResult> => {
            const statusEntry = await stores.state.get('voice.status');
            const callSidEntry = await stores.state.get('voice.callSid');
            const lastTranscriptEntry = await stores.state.get('voice.lastTranscript');

            return jsonResult({
              status: statusEntry?.value ?? 'idle',
              callSid: callSidEntry?.value ?? null,
              lastTranscript: lastTranscriptEntry?.value ?? null,
              activeCall: service?.getActiveCall() ? {
                to: service.getActiveCall()!.to,
                startedAt: service.getActiveCall()!.startedAt,
                transcriptCount: service.getActiveCall()!.transcript.length,
              } : null,
            });
          },
        },
      ];
    },

    destroy(): void {
      if (service) {
        service.destroy().catch(() => {});
        service = null;
      }
    },
  };
}

/**
 * Get Twilio webhook handlers from the voice service.
 * Used by the incubator HTTP server to register routes.
 */
export interface VoiceRouteHandlers {
  handleTwiml: () => string;
  handleStatus: (body: Record<string, unknown>) => void;
  handleMediaWs: (ws: unknown) => void;
  getActiveCall: () => unknown;
}

/**
 * After creating the voice plugin and calling start(),
 * the service instance is accessible for route registration.
 * This helper extracts the handlers the HTTP server needs.
 *
 * Usage in index.ts:
 *   const voicePlugin = createVoicePlugin(config, stores);
 *   await voicePlugin.start(ctx);
 *   // Later, register routes using the service reference
 */
