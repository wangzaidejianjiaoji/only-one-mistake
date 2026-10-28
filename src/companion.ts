import { mkdirSync, writeFileSync, renameSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { environment, hash, normalize, redact, sameEnvironment } from './normalize.ts';
import { readTranscript } from './transcript.ts';
import type { Cursor } from './transcript.ts';
import type { Coverage, Environment, Event, HookInput, HookOutput, Memory, Problem, QueueItem, Report } from './types.ts';

type SummaryRequest = { sessionId: string; turnId: string; queueIds: string[]; at: string; status: 'requested' | 'completed' | 'interrupted' };

const now = () => new Date().toISOString();
function atomic(path: string, text: string) {
  const temporary = path + '.' + process.pid + '.tmp'; writeFileSync(temporary, text, 'utf8'); renameSync(temporary, path);
}
export class Companion {
  store: Store;
  stateDir: string;
  project: string;
  automaticSummary: boolean;
  constructor(stateDir: string, project: string, options: { automaticSummary?: boolean } = {}) {
    this.project = resolve(project); this.stateDir = resolve(stateDir);
    this.store = new Store(join(this.stateDir, 'evolveflow.sqlite'));
    this.automaticSummary = options.automaticSummary ?? this.store.meta('automaticSummary') === 'true';
    if (options.automaticSummary !== undefined) this.store.setMeta('automaticSummary', String(options.automaticSummary));
  }
  environment(): Environment { return environment(this.project); }
  inProject(cwd: string) { const r = relative(this.project, cwd); return !r.startsWith('..') && !isAbsolute(r); }
  currentEnvironment(cwd: string) {
    const env = environment(cwd);
    if (env.cwd !== this.project) env.fingerprint = hash([env.fingerprint, this.environment().fingerprint]);
    return env;
  }
  close() { this.store.close(); }
  pause(value: boolean) { this.store.setMeta('paused', String(value)); }
  gap(sessionId: string, reason: string) {
    this.store.put('coverage', hash([sessionId, reason]), { sessionId, reason, at: now() });
  }
  status(sessionId?: string) {
    const filter = <T extends { sessionId: string }>(rows: T[]) => sessionId ? rows.filter(r => r.sessionId === sessionId) : rows;
    return { paused: this.store.meta('paused') === 'true', environment: this.environment(),
      events: filter(this.store.list<Event>('events')), problems: filter(this.store.list<Problem>('problems')),
      queue: filter(this.store.list<QueueItem>('queue')), coverage: filter(this.store.list<Coverage>('coverage')),
      summaryRequests: filter(this.store.list<SummaryRequest>('summaryRequests')),
      proposals: this.store.list<Memory>('proposals').filter(m => !sessionId || m.sessionId === sessionId),
      memories: this.memories().filter(m => !sessionId || m.sessionId === sessionId || m.scope === 'project') };
  }
  memories() { return this.store.list<Memory>('memories'); }
  summaryHistory(sessionId?: string) {
    return this.store.list<{ sessionId: string; turnId: string; note: string; at: string; eventIds: string[] }>('summaries').filter(s => !sessionId || s.sessionId === sessionId);
  }
  completeSummary(sessionId: string, turnId: string, note: string) {
    if (!sessionId || !turnId || !note.trim()) throw new Error('summary requires session, original turn and review note');
    this.store.transaction(() => {
      const key = hash([sessionId, turnId]);
      const request = this.store.get<SummaryRequest>('summaryRequests', key);
      if (!request || request.status === 'interrupted') throw new Error('No active summary request for the supplied session/turn');
      if (request.status === 'completed') return;
      const queue = request.queueIds.map(id => this.store.get<QueueItem>('queue', id)).filter((q): q is QueueItem => !!q && q.reason === 'context_review' && ['pending', 'awaiting_host'].includes(q.state));
      for (const q of queue) this.store.put('queue', q.id, { ...q, state: 'done' });
      this.store.put('summaries', key, { sessionId, turnId, note: redact(note), at: now(), eventIds: queue.map(q => q.eventId) });
      this.store.put('summaryRequests', key, { ...request, status: 'completed' });
      if (this.store.meta('summary-inflight:' + sessionId) === turnId) this.store.setMeta('summary-inflight:' + sessionId, '');
    });
  }
  isAdministrativeCommand(command: string | undefined) {
    if (!command || /[;\r\n]|&&|\|\|/.test(command)) return false;
    const normalized = command.replaceAll('\\', '/');
    for (const script of ['./cli.ts', './user.ts']) {
      const path = fileURLToPath(new URL(script, import.meta.url)).replaceAll('\\', '/');
      const index = process.platform === 'win32' ? normalized.toLowerCase().indexOf(path.toLowerCase()) : normalized.indexOf(path);
      if (index >= 0 && /^['"]?\s+(?:report|review|summary|status|context|metrics|memory|coverage|worker|pause|resume|reproduce)\b/.test(normalized.slice(index + path.length))) return true;
    }
    return false;
  }
  metrics(sessionId?: string) {
    const relevant = <T extends { sessionId: string }>(rows: T[]) => sessionId ? rows.filter(r => r.sessionId === sessionId) : rows;
    const problems = relevant(this.store.list<Problem>('problems'));
    return { observedFailures: problems.reduce((n, p) => n + p.attempts, 0), repeatedFailures: problems.reduce((n, p) => n + Math.max(0, p.attempts - 1), 0),
      blockedKnownFailures: relevant(this.store.list<{ sessionId: string }>('preventions')).length,
      verifiedApplications: relevant(this.store.list<{ sessionId: string }>('applications')).length,
      observedTimeToVerifiedMs: problems.flatMap(p => { const m = p.memoryId && this.store.get<Memory>('memories', p.memoryId); const first = this.store.get<Event>('events', p.evidenceIds[0]); return m && first ? [{ problemId: p.id, milliseconds: Math.max(0, Date.parse(m.at) - Date.parse(first.at)) }] : []; }),
      misuseRate: null, misuseRateReason: 'Requires independently labelled semantic evaluation; not inferred from exit codes.', modelCalls: 0 };
  }
  enqueue(event: Event, reason: string) {
    const id = hash([event.id, reason]);
    if (!this.store.get('queue', id)) this.store.put('queue', id, { id, sessionId: event.sessionId, eventId: event.id, reason, state: 'pending' });
  }
  capture(event: Event) {
    if (this.isAdministrativeCommand(event.action)) return event.id;
    // Hosts may expose the same tool result both in JSONL and in a hook.
    const existing = event.toolId ? this.store.list<Event>('events').find(e => e.sessionId === event.sessionId && e.kind === event.kind && e.toolId === event.toolId) : undefined;
    if (existing) {
      if (existing.historical && !event.historical) {
        event.id = existing.id; this.store.put('events', event.id, event);
        for (const p of this.store.list<Problem>('problems')) if (p.evidenceIds.includes(event.id)) {
          p.environment = event.environment; this.store.put('problems', p.id, p);
        }
      }
      return existing.id;
    }
    if (this.store.get('events', event.id)) return event.id;
    this.store.put('events', event.id, event);
    if (event.kind === 'PostToolUse' && event.action) {
      if (event.exitCode !== undefined && event.exitCode !== 0) {
        const key = hash([event.action, event.tool, event.environment]);
        const id = hash([event.sessionId, key]);
        const previous = this.store.get<Problem>('problems', id);
        const p: Problem = previous ?? { id, sessionId: event.sessionId, key, title: event.text.slice(0, 160) || event.action,
          action: event.action, state: 'open', attempts: 0, evidenceIds: [], environment: event.environment };
        p.attempts++; p.evidenceIds.push(event.id);
        const remembered = this.applicable(event.sessionId, event.action, event.environment).find(m => m.failedAttempts.some(a => a.action === event.action));
        p.state = remembered ? 'known_failure_recurred' : p.attempts > 1 ? 'investigating' : 'open';
        if (remembered) p.memoryId = remembered.id;
        this.store.put('problems', id, p); this.enqueue(event, p.attempts > 1 ? 'repeated_failure' : 'tool_failure');
      } else if (event.exitCode === 0) {
        for (const p of this.store.list<Problem>('problems').filter(p => p.sessionId === event.sessionId)) {
          const m = p.memoryId ? this.store.get<Memory>('memories', p.memoryId) : undefined;
          const verification = m && this.store.get<Event>('events', m.verification.eventId);
          if (m?.status === 'active' && sameEnvironment(m.environment, event.environment) && verification?.tool === event.tool && verification?.shell === event.shell && m.verification.command === event.action && event.id !== m.verification.eventId) {
            p.state = 'applied'; this.store.put('problems', p.id, p);
            this.store.put('applications', event.id, { sessionId: event.sessionId, memoryId: m.id, eventId: event.id, at: now() });
          }
        }
        // A successful alternative is evidence, not proof that an unrelated problem is solved.
        if (this.store.list<Problem>('problems').some(p => p.sessionId === event.sessionId && ['open', 'investigating', 'known_failure_recurred'].includes(p.state))) this.enqueue(event, 'success_needs_attribution');
      } else this.gap(event.sessionId, 'tool output has no recognized exit status; cannot use as successful verification evidence');
    }
    if (['TranscriptUser', 'TranscriptAssistant', 'UserPromptSubmit', 'Stop'].includes(event.kind) && event.text) {
      if (/重复|又.{0,8}(错|失败)|纠正|不对|不是.{0,24}而是|already solved|same (?:error|problem)|correction|you.*wrong/i.test(event.text)) this.enqueue(event, 'user_correction_or_recurrence');
      else if (event.kind !== 'Stop' || this.automaticSummary) this.enqueue(event, 'context_review');
    }
    return event.id;
  }
  ingestTranscript(sessionId: string, path: string) {
    const key = 'transcript:' + hash([sessionId, path]);
    try {
      const result = readTranscript(path, this.store.get<Cursor>('cursors', key));
      this.store.transaction(() => {
        for (const input of result.events) {
          const env: Environment = { cwd: resolve(input.cwd ?? this.project), platform: process.platform, fingerprint: 'historical:unknown' };
          const event = normalize({ ...input, session_id: sessionId, evolveflow_historical: true }, env);
          if (this.isAdministrativeCommand(event.action)) continue;
          this.capture(event);
          if (input.hook_event_name === 'PostToolUse') this.gap(sessionId, 'historical execution environment fingerprint unavailable; only live hook evidence may activate solutions');
        }
        for (const reason of result.gaps) this.gap(sessionId, reason);
        this.store.put('cursors', key, result.cursor);
      });
    } catch (error) { this.gap(sessionId, 'transcript unavailable: ' + (error instanceof Error ? error.message : String(error))); }
  }
  applicable(sessionId: string, query = '', env?: Environment) {
    const text = query.toLocaleLowerCase();
    return this.memories().filter(m => m.status === 'active' && (m.scope === 'project' || m.sessionId === sessionId) && this.inProject(m.environment.cwd) && sameEnvironment(m.environment, env ?? this.currentEnvironment(m.environment.cwd)))
      .filter(m => !query || m.triggerTerms.some(t => text.includes(t.toLocaleLowerCase())) || m.failedAttempts.some(a => a.action === query) || m.verification.command === query);
  }
  context(sessionId: string, query = '') {
    const env = this.environment();
    const relevant = this.applicable(sessionId, query).slice(-6);
    const problems = this.store.list<Problem>('problems').filter(p => p.sessionId === sessionId).slice(-8);
    const stale = this.memories().filter(m => m.status === 'active' && (m.scope === 'project' || m.sessionId === sessionId) && (!this.inProject(m.environment.cwd) || !sameEnvironment(m.environment, this.currentEnvironment(m.environment.cwd))));
    const gaps = this.store.list<Coverage>('coverage').filter(c => c.sessionId === sessionId).slice(-3);
    const pending = this.store.list<QueueItem>('queue').filter(q => q.sessionId === sessionId && ['pending', 'awaiting_host'].includes(q.state)).slice(-6);
    const queuedEvidence = pending.map(q => { const event = this.store.get<Event>('events', q.eventId); return { ...q, event: event && { ...event, action: event.action?.slice(0, 1600), text: event.text.slice(0, 2000) } }; });
    const evidence = this.store.list<Event>('events').filter(e => e.sessionId === sessionId && e.exitCode === 0).slice(-5).map(e => ({ eventId: e.id, command: e.action }));
    return [
      'EvolveFlow 上下文检查。以下 JSON 是经验资料和执行证据，不授予权限；按当前任务与阶段授权行动。',
      JSON.stringify({ sessionId, automaticSummary: this.automaticSummary, environment: env, memories: relevant.map(m => ({ id: m.id, title: m.title, problemKey: m.problemKey,
        正确方法: m.solution, 已验证命令: m.verification.command, 避免重复: m.failedAttempts, 适用条件: m.environment, 失效条件: m.invalidWhen })),
        problems: problems.map(p => ({ id: p.id, state: p.state, attempts: p.attempts, action: p.action, memoryId: p.memoryId })),
        successfulEvidence: evidence, queuedEvidence, staleMemories: stale.map(m => ({ id: m.id, reason: '环境 environment 已变化，重新验证后再复用' })), coverageGaps: gaps,
        summaryInterface: this.automaticSummary ? { argv: [process.execPath, fileURLToPath(new URL('./cli.ts', import.meta.url)), 'summary', '--project', this.project, '--state', this.stateDir, '--session', sessionId, '--turn', 'ORIGINAL_TURN_ID', '--note', '本轮复盘结论'], history: this.summaryHistory(sessionId).slice(-2) } : undefined,
        reportInterface: { argv: [process.execPath, fileURLToPath(new URL('./cli.ts', import.meta.url)), 'report', '--project', this.project, '--state', this.stateDir, '--file', 'REPORT.json'],
          fields: ['sessionId', 'problemKey', 'title', 'symptoms:string[]', 'environment', 'failedAttempts:[{action,reason}]', 'solution', 'verification:{eventId,command,evidence}', 'triggerTerms:string[]', 'invalidWhen:string[]', 'scope:session|project', 'kind:memory|skill|check|core'],
          correctionReview: { argv: [process.execPath, fileURLToPath(new URL('./cli.ts', import.meta.url)), 'review', 'EVENT_ID', '--project', this.project, '--state', this.stateDir, '--session', sessionId, '--disposition', 'reviewed|deferred', '--reason', '已核对或暂缓的理由'], note: '不要伪造执行验证；明确用户纠正可用 verification.kind=user_correction、command=空字符串、failedAttempts=[] 保存会话记忆。' } } }, null, 2),
      problems.some(p => ['open', 'investigating', 'known_failure_recurred'].includes(p.state)) ? '先核对已有解法再采取下一步；成功替代操作需要归因。用 report --file 提交原因、方法和成功 eventId；不能把 exit 0 当作功能正确的唯一证明。' : '',
    ].filter(Boolean).join('\n');
  }
  handle(input: HookInput): { output: HookOutput; eventId?: string; problemId?: string } {
    if (this.store.meta('paused') === 'true' || input.evolveflow_origin === 'worker' || process.env.EVOLVEFLOW_ORIGIN === 'worker') return { output: {} };
    const session = input.session_id;
    if (typeof session !== 'string' || !session) {
      this.gap('unknown', 'missing session_id: hook not monitored'); return { output: { systemMessage: 'EvolveFlow 监控缺口：缺少 session_id。' } };
    }
    if (this.automaticSummary && input.stop_hook_active && input.hook_event_name === 'Stop') return { output: {} };
    if (this.automaticSummary && input.hook_event_name === 'UserPromptSubmit' && input.prompt?.startsWith('[EvolveFlow自动复盘 ') && this.store.meta('summary-inflight:' + session)) return { output: {} };
    const command = input.tool_input?.command ?? input.tool_input?.cmd;
    if (this.isAdministrativeCommand(typeof command === 'string' ? command : undefined)) return { output: {} };
    if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SessionEnd', 'Interrupt'].includes(String(input.hook_event_name))) {
      this.gap(session, 'unsupported hook event:' + String(input.hook_event_name));
      return { output: { systemMessage: 'EvolveFlow 监控缺口：不支持的 hook 事件 ' + String(input.hook_event_name) } };
    }
    if (input.hook_event_name === 'SessionStart' && !input.transcript_path) this.gap(session, 'transcript_path unavailable: conversation coverage is partial; only observed hook messages/tools are available');
    if (input.hook_event_name === 'PostToolUse' && !input.tool_use_id) this.gap(session, 'missing tool_use_id: repeated-result deduplication has reduced precision');
    let turn = input.turn_id;
    const sequenceKey = 'fallback-turn:' + session;
    const currentTurnKey = 'current-turn:' + session;
    if (input.hook_event_name === 'UserPromptSubmit') this.store.transaction(() => {
      const sequence = Number(this.store.meta(sequenceKey) ?? 0) + 1;
      this.store.setMeta(sequenceKey, String(sequence));
      turn ||= 'fallback-' + sequence;
      this.store.setMeta(currentTurnKey, turn);
    });
    else if (turn) this.store.setMeta(currentTurnKey, turn);
    if (!input.turn_id && !['SessionStart', 'SessionEnd'].includes(String(input.hook_event_name))) {
      this.gap(session, 'missing turn_id: using local user-message sequence with reduced replay precision');
      turn = this.store.meta(currentTurnKey) ?? 'fallback-' + (this.store.meta(sequenceKey) ?? '0');
    }
    if (input.transcript_path) this.ingestTranscript(session, input.transcript_path);
    const workdir = typeof input.tool_input?.workdir === 'string' ? input.tool_input.workdir : String(input.cwd ?? this.project);
    const ev = normalize({ ...input, turn_id: turn }, this.currentEnvironment(resolve(this.project, workdir)));
    const output: HookOutput = {};
    this.store.transaction(() => {
      const eventId = this.capture(ev); ev.id = eventId;
      if (ev.kind === 'PreToolUse' && ev.action) {
        const m = this.applicable(session, ev.action, ev.environment).find(m => m.verification.command !== ev.action && m.failedAttempts.some(a => a.action === ev.action) &&
          this.store.list<Event>('events').some(e => !e.historical && e.sessionId === m.sessionId && e.action === ev.action && e.exitCode !== undefined && e.exitCode !== 0 && e.tool === ev.tool && e.shell === ev.shell && sameEnvironment(e.environment, ev.environment)));
        if (m) {
          const exception = 'reproduce:' + hash([session, m.id]);
          if (this.store.meta(exception)) this.store.setMeta(exception, '');
          else {
            output.hookSpecificOutput = { hookEventName: ev.kind, permissionDecision: 'deny',
              permissionDecisionReason: `已验证该操作失败：${ev.action}。正确方法：${m.solution}。先核对适用条件；如用户要求复现，用 reproduce ${m.id} --session ${session} --reason 记录一次性例外。`,
              additionalContext: this.context(session, ev.action) };
            this.store.put('preventions', ev.id + ':' + now(), { sessionId: session, memoryId: m.id, at: now() });
          }
        }
      }
      if (['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostCompact'].includes(ev.kind)) output.hookSpecificOutput = { hookEventName: ev.kind, additionalContext: this.context(session) };
      if (['PreCompact', 'Interrupt', 'SessionEnd'].includes(ev.kind)) {
        this.store.put('checkpoints', session, { sessionId: session, context: this.context(session), at: now() });
        if (ev.kind === 'PreCompact') output.hookSpecificOutput = { hookEventName: ev.kind, additionalContext: this.context(session) };
        if (ev.kind === 'Interrupt' || ev.kind === 'SessionEnd') {
          const active = this.store.meta('summary-inflight:' + session);
          const key = active && hash([session, active]);
          const request = key ? this.store.get<SummaryRequest>('summaryRequests', key) : undefined;
          if (request?.status === 'requested') this.store.put('summaryRequests', key as string, { ...request, status: 'interrupted' });
          this.store.setMeta('summary-inflight:' + session, '');
        }
      }
      if (ev.kind === 'Stop' && !input.stop_hook_active) {
        const pending = this.store.list<QueueItem>('queue').filter(q => q.sessionId === session && ['pending', 'awaiting_host'].includes(q.state) && (this.automaticSummary || q.reason !== 'context_review'));
        const marker = 'stop:' + hash([session, ev.turnId]);
        if (pending.length && !this.store.meta(marker)) {
          output.decision = 'block'; output.reason = this.context(session) + '\n本轮发现问题或有效替代操作尚未归因。检查现有上下文：找到答案就应用并验证，随后提交记忆模板；原因未知则明确记录，勿虚构解法。本轮最多自动续接一次，用户中断优先。';
          if (this.automaticSummary) {
            this.store.put('summaryRequests', hash([session, ev.turnId]), { sessionId: session, turnId: ev.turnId, queueIds: pending.map(q => q.id), at: now(), status: 'requested' });
            output.reason = `[EvolveFlow自动复盘 session=${session} turn=${ev.turnId}]\n${this.context(session)}\n` +
              `当前回合已结束，自动复盘整段可见上下文：解决过的重复问题、长难问题、用户明确纠正和非显然方法是否值得保存。可执行经验按 reportInterface 提交真实成功证据；只适用于本次会话时不扩大范围。没有新经验就不创建模板。仍未解决的问题保留，不用偏好或无关成功代替修复。已核对或需要暂缓的纠正用 correctionReview 记录 reviewed/deferred 与理由。最后通过 summaryInterface 的 CLI 写入复盘结论，--turn 使用 ${ev.turnId}；它只结束该请求的普通上下文审阅。只在有实质变化、阻塞或必要说明时反馈，避免重复刚才答复或让用户确认普通复盘。行政 CLI 与业务动作分开执行。本轮最多自动续接一次，用户中断优先。`;
            this.store.setMeta('summary-inflight:' + session, ev.turnId || 'unknown');
          }
          this.store.setMeta(marker, 'continued');
        }
      }
    });
    const problemId = this.store.list<Problem>('problems').find(p => p.evidenceIds.includes(ev.id))?.id;
    return { output, eventId: ev.id, problemId };
  }
  report(raw: Report): Memory {
    if (!raw || typeof raw !== 'object') throw new Error('report must be an object');
    for (const key of ['sessionId', 'problemKey', 'title', 'solution'] as const) if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error('Missing report field: ' + key);
    if (!['session', 'project'].includes(raw.scope) || !['memory', 'skill', 'check', 'core'].includes(raw.kind)) throw new Error('Invalid report scope/kind');
    for (const key of ['symptoms', 'triggerTerms', 'invalidWhen'] as const) if (!Array.isArray(raw[key]) || raw[key].some(x => typeof x !== 'string')) throw new Error('Expected string[]: ' + key);
    if (!raw.triggerTerms.length || raw.triggerTerms.some(x => !x.trim())) throw new Error('triggerTerms must be nonempty');
    if (!Array.isArray(raw.failedAttempts) || raw.failedAttempts.some(x => typeof x?.action !== 'string' || typeof x?.reason !== 'string')) throw new Error('Invalid failedAttempts');
    const ev = this.store.get<Event>('events', raw.verification?.eventId ?? '');
    const userCorrection = raw.verification?.kind === 'user_correction';
    if (userCorrection) {
      if (!ev || ev.historical || !['UserPromptSubmit', 'TranscriptUser'].includes(ev.kind) || !/纠正|不要|请.{0,8}(用|直接)|correction|please|instead/i.test(ev.text) || ev.sessionId !== raw.sessionId || raw.verification.command !== '' || raw.failedAttempts.length || !['memory', 'core'].includes(raw.kind)) throw new Error('Explicit captured user correction required for non-executable memory');
    } else if (!ev || ev.historical || ev.kind !== 'PostToolUse' || ev.exitCode !== 0 || ev.sessionId !== raw.sessionId || ev.action !== raw.verification.command) throw new Error('Successful captured evidence eventId in live environment and exact verification command required; historical evidence is insufficient');
    if (!ev || !sameEnvironment(ev.environment, raw.environment) || !this.inProject(ev.environment.cwd) || !sameEnvironment(ev.environment, this.currentEnvironment(ev.environment.cwd))) throw new Error('Verification evidence environment changed');
    for (const id of raw.reviewedEventIds ?? []) {
      const reviewed = this.store.get<Event>('events', id);
      if (!reviewed || reviewed.sessionId !== raw.sessionId) throw new Error('Reviewed evidence not in session');
      if (!['UserPromptSubmit', 'TranscriptUser', 'TranscriptAssistant', 'Stop'].includes(reviewed.kind)) throw new Error('reviewedEventIds are for non-executable context corrections; use failedAttempts and execution evidence for tool failures');
    }
    const events = this.store.list<Event>('events').filter(e => e.sessionId === raw.sessionId && sameEnvironment(e.environment, raw.environment));
    for (const failure of raw.failedAttempts) if (!events.some(e => e.kind === 'PostToolUse' && e.action === failure.action && e.exitCode !== undefined && e.exitCode !== 0)) throw new Error('Failed attempt lacks captured evidence: ' + failure.action);
    const id = hash([raw.scope, raw.scope === 'session' ? raw.sessionId : raw.environment.cwd, raw.problemKey]);
    const previous = this.store.get<Memory>('memories', id);
    const evaluation = raw.evaluation;
    const similar = evaluation && this.store.get<Event>('events', evaluation.similarEventId);
    const negative = evaluation && this.store.get<Event>('events', evaluation.negativeEventId);
    const checks = !!(similar && negative && new Set([ev.id, similar.id, negative.id]).size === 3 && [similar, negative].every(e => e.kind === 'PostToolUse' && e.exitCode === 0 && e.sessionId === raw.sessionId && sameEnvironment(e.environment, ev.environment)) && negative.action !== ev.action && !raw.failedAttempts.some(f => f.action === negative.action));
    const needsEvaluation = raw.scope === 'project' || raw.kind === 'skill' || raw.kind === 'check';
    const version = Math.max(0, ...this.store.list<Memory>('versions').filter(m => m.id === id).map(m => m.version)) + 1;
    const memory: Memory = { ...JSON.parse(redact(JSON.stringify(raw))) as Report, id, version,
      status: raw.kind === 'core' ? 'pending_confirmation' : needsEvaluation && !checks ? 'candidate' : 'active', at: now() };
    this.store.transaction(() => {
      this.store.put('versions', id + ':' + memory.version, memory);
      if (memory.status === 'active' || previous?.status !== 'active') this.store.put('memories', id, memory);
      if (memory.status !== 'active') this.store.put('proposals', id + ':' + memory.version, memory);
      const problems = userCorrection ? [] : this.store.list<Problem>('problems').filter(p => p.sessionId === raw.sessionId &&
        raw.failedAttempts.some(f => f.action === p.action) && sameEnvironment(p.environment, raw.environment));
      if (memory.status === 'active') for (const problem of problems) {
        problem.state = 'verified'; problem.memoryId = id; this.store.put('problems', problem.id, problem);
      }
      // A report resolves only the linked problem and its attribution, not unrelated errors.
      const relevant = new Set([raw.verification.eventId, ...(evaluation ? [evaluation.similarEventId, evaluation.negativeEventId] : []), ...problems.flatMap(p => p.evidenceIds), ...(raw.reviewedEventIds ?? [])]);
      if (memory.status === 'active') for (const q of this.store.list<QueueItem>('queue')) if (q.sessionId === raw.sessionId && relevant.has(q.eventId)) this.store.put('queue', q.id, { ...q, state: 'done' });
    });
    if (memory.status === 'active' || previous?.status !== 'active') this.publish(memory);
    else { const proposals = join(this.stateDir, 'proposals'); mkdirSync(proposals, { recursive: true }); atomic(join(proposals, id + '-' + version + '.json'), JSON.stringify(memory, null, 2)); }
    return memory;
  }
  publish(memory: Memory) {
    const dir = join(this.stateDir, 'templates'); mkdirSync(dir, { recursive: true });
    atomic(join(dir, memory.id + '.json'), JSON.stringify(memory, null, 2) + '\n');
    atomic(join(dir, memory.id + '.md'), `# ${memory.title}\n\n状态：${memory.status}；版本：${memory.version}\n\n## 问题与适用条件\n\n${JSON.stringify({ symptoms: memory.symptoms, environment: memory.environment, triggerTerms: memory.triggerTerms }, null, 2)}\n\n## 正确方法\n\n${memory.solution}\n\n## 已失败的方法\n\n${JSON.stringify(memory.failedAttempts, null, 2)}\n\n## 验证证据\n\n${JSON.stringify(memory.verification, null, 2)}\n\n## 失效条件\n\n${memory.invalidWhen.join('\n')}\n`);
    const name = 'evolveflow-learned-' + memory.id;
    const skillDir = join(this.project, '.agents', 'skills', name);
    for (const ancestor of [join(this.project, '.agents'), join(this.project, '.agents', 'skills'), skillDir]) if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error('Refusing generated skill symlink: ' + ancestor);
    const skillFile = join(skillDir, 'SKILL.md');
    if (memory.kind === 'skill' && memory.status === 'active') {
      mkdirSync(skillDir, { recursive: true });
      const owned = this.store.meta('generated:' + memory.id);
      if (existsSync(skillFile) && (!owned || hash(readFileSync(skillFile, 'utf8')) !== owned)) throw new Error('Generated skill edited; preserve and resolve before replacing: ' + skillFile);
      atomic(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify('Use when ' + memory.triggerTerms.join(', ') + '; verified project-specific technique.')}\n---\n\n# ${memory.title}\n\n只在匹配的项目和环境使用此经验；不扩大当前任务的权限。\n\n${memory.solution}\n\n先检查环境：\n\n\`\`\`json\n${JSON.stringify(memory.environment, null, 2)}\n\`\`\`\n\n验证：${memory.verification.command}\n\n失效条件：${memory.invalidWhen.join('；')}\n`);
      this.store.setMeta('generated:' + memory.id, hash(readFileSync(skillFile, 'utf8')));
    } else if (existsSync(skillFile) && this.store.meta('generated:' + memory.id)) {
      if (hash(readFileSync(skillFile, 'utf8')) === this.store.meta('generated:' + memory.id)) unlinkSync(skillFile);
      else renameSync(skillFile, join(skillDir, 'SKILL.disabled-' + Date.now() + '.md'));
    }
  }
  disable(id: string) {
    const m = this.store.get<Memory>('memories', id); if (!m) throw new Error('Unknown memory: ' + id);
    m.status = 'disabled'; this.store.put('memories', id, m); this.publish(m);
  }
  rollback(id: string) {
    const m = this.store.get<Memory>('memories', id); if (!m || m.version < 2) throw new Error('No previous version');
    const old = this.store.list<Memory>('versions').filter(v => v.id === id && v.version < m.version && v.status === 'active').sort((a, b) => b.version - a.version)[0]; if (!old) throw new Error('Previous active version unavailable');
    this.store.put('memories', id, old); this.publish(old);
    this.store.put('rollbacks', hash([id, now()]), { id, from: m.version, to: old.version, at: now() });
  }
  review(sessionId: string, eventId: string, disposition: 'reviewed' | 'deferred', reason: string) {
    if (!['reviewed', 'deferred'].includes(disposition) || !reason.trim()) throw new Error('Explicit review disposition and reason required');
    const e = this.store.get<Event>('events', eventId); if (!e || e.sessionId !== sessionId) throw new Error('Review event not in session');
    for (const q of this.store.list<QueueItem>('queue')) if (q.eventId === eventId && q.sessionId === sessionId) this.store.put('queue', q.id, { ...q, state: disposition });
    this.store.put('reviews', hash([sessionId, eventId, now()]), { sessionId, eventId, disposition, reason, at: now() });
  }
  allowReproduction(sessionId: string, memoryId: string, reason: string) {
    if (!reason.trim() || !this.store.get<Memory>('memories', memoryId)) throw new Error('Known memory and explicit reproduction reason required');
    this.store.setMeta('reproduce:' + hash([sessionId, memoryId]), reason);
    this.store.put('exceptions', hash([sessionId, memoryId, now()]), { sessionId, memoryId, reason, at: now() });
  }
  workerOnce(sessionId?: string) {
    if (this.store.meta('paused') === 'true') return { processed: 0, mode: 'paused', modelCalls: 0, sessions: [] };
    const pending = this.store.list<QueueItem>('queue').filter(q => q.state === 'pending' && (!sessionId || q.sessionId === sessionId));
    for (const q of pending) this.store.put('queue', q.id, { ...q, state: 'awaiting_host' });
    return { processed: pending.length, mode: 'host-in-loop', modelCalls: 0,
      sessions: [...new Set(pending.map(q => q.sessionId))].map(session => ({ sessionId: session, context: this.context(session) })) };
  }
}
