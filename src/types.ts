export type Environment = { cwd: string; platform: string; version?: string; fingerprint?: string };
export type HookInput = {
  session_id?: string; turn_id?: string; hook_event_name?: string; cwd?: string;
  tool_name?: string; tool_use_id?: string; tool_input?: Record<string, unknown>; tool_response?: unknown;
  prompt?: string; last_assistant_message?: string; transcript_path?: string | null;
  stop_hook_active?: boolean; evolveflow_origin?: string; [key: string]: unknown;
};
export type HookOutput = {
  decision?: 'block'; reason?: string; systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string; permissionDecision?: 'deny'; permissionDecisionReason?: string };
};
export type Event = {
  id: string; sessionId: string; turnId: string; kind: string; toolId?: string;
  action?: string; tool?: string; shell?: string; historical?: boolean; exitCode?: number; text: string; environment: Environment; at: string;
};
export type Problem = { id: string; sessionId: string; key: string; title: string; state: string;
  action: string; attempts: number; evidenceIds: string[]; environment: Environment; memoryId?: string };
export type Report = {
  sessionId: string; problemKey: string; title: string; symptoms: string[];
  environment: Environment; failedAttempts: { action: string; reason: string }[];
  solution: string; verification: { eventId: string; command: string; kind?: 'execution' | 'user_correction'; evidence?: string; exitCode?: number; output?: string };
  triggerTerms: string[]; invalidWhen: string[]; scope: 'session' | 'project'; kind: 'memory' | 'skill' | 'check' | 'core';
  evaluation?: { similarEventId: string; negativeEventId: string };
  reviewedEventIds?: string[];
};
export type Memory = Report & { id: string; version: number; status: 'active' | 'candidate' | 'pending_confirmation' | 'disabled'; at: string };
export type Coverage = { sessionId: string; reason: string; at: string };
export type QueueItem = { id: string; sessionId: string; eventId: string; state: 'pending' | 'awaiting_host' | 'done' | 'reviewed' | 'deferred'; reason: string };
