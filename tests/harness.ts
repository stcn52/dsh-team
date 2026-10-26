/**
 * Test doubles for the harness seams dsh-team consumes. Every double is the
 * narrowest thing that satisfies one seam's contract — a fake that grew a
 * behaviour of its own would test itself instead of the plugin.
 *
 * @module dsh-team/tests/harness
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'

/** One delivery an agent double accepted through its inbox. */
export interface AcceptedMessage {
  readonly message: UserMessage
  readonly target: string
  readonly wakeup: boolean
}

/** A live-agent double: identity, header lineage, log, and an inbox recorder. */
export interface FakeAgent {
  readonly id: SessionIdType
  status: 'idle' | 'running'
  readonly session: {
    header: Record<string, unknown>
    events: SessionEvent[]
    snapshotEvents(): readonly SessionEvent[]
  }
  readonly options: { provider?: string; model?: string; reasoningEffort?: string }
  readonly ctx: Context
  readonly tools: FakeTools
  readonly prompt: FakeSystemPrompt
  readonly received: AcceptedMessage[]
  /**
   * The pending-work queue the real Agent publishes as `inbox`. `send` routes
   * into it exactly as the runtime does, so a test can also seed one directly:
   * a message sitting here has been accepted but not yet spliced into the log.
   */
  readonly inbox: { readonly nextTurn: UserMessage[]; readonly nextStep: UserMessage[] }
  /** Messages accepted through `steer` (the command plane's submission path). */
  readonly steered: UserMessage[]
  /** Resolvers of `whenIdle()` calls still pending, oldest first. */
  readonly idleWaiters: Array<() => void>
  /** How many times `whenIdle()` was called, so a test can prove nobody observed this agent. */
  idleCalls: number
  send(message: UserMessage, target: string, wakeup: boolean): void
  steer(message: UserMessage): void
  /** The harness's own quiescence seam: resolves now while idle, on release while running. */
  whenIdle(): Promise<void>
  /** End the current activity: status becomes idle and every pending `whenIdle()` resolves. */
  goIdle(): void
  /** The same double under the seam's own type, for service and tool calls. */
  readonly agent: Agent
}

/**
 * Build one agent double.
 * @param id - the session id this agent is published under.
 * @param options - lineage (`parent` makes it a teammate), route overrides, and
 * the global (inherited) tool names this scope can see.
 * @returns the double, already usable as an `Agent`.
 */
export function fakeAgent(id: string, options: {
  readonly parent?: string
  readonly status?: 'idle' | 'running'
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly events?: SessionEvent[]
  readonly globals?: readonly string[]
} = {}): FakeAgent {
  const self: FakeAgent = {
    id: SessionId(id),
    status: options.status ?? 'idle',
    session: {
      header: options.parent === undefined
        ? { origin: 'user', isSeeded: false }
        : { origin: 'subagent', parentSession: SessionId(options.parent), isSeeded: false },
      events: options.events ?? [],
      snapshotEvents() { return this.events },
    },
    options: {
      ...options.provider !== undefined ? { provider: options.provider } : {},
      ...options.model !== undefined ? { model: options.model } : {},
      ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {},
    },
    ctx: new Context(),
    tools: new FakeTools(),
    prompt: new FakeSystemPrompt(),
    received: [],
    inbox: { nextTurn: [], nextStep: [] },
    steered: [],
    idleWaiters: [],
    idleCalls: 0,
    send(message, target, wakeup) {
      this.received.push({ message, target, wakeup })
      // The real `Agent.send` parks the message on the chosen inbox boundary;
      // mirroring that is what lets a test read the queue a wait sees.
      if (target === 'next-step') this.inbox.nextStep.push(message)
      else this.inbox.nextTurn.push(message)
    },
    steer(message) {
      this.steered.push(message)
    },
    whenIdle() {
      this.idleCalls += 1
      if (this.status === 'idle') return Promise.resolve()
      return new Promise<void>(resolve => { this.idleWaiters.push(resolve) })
    },
    goIdle() {
      this.status = 'idle'
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    },
    get agent(): Agent {
      return self as unknown as Agent
    },
  }
  for (const name of options.globals ?? []) self.tools.inherited.add(name)
  self.ctx.provide('agent', self.agent)
  self.ctx.provide('tools', self.tools)
  self.ctx.provide('systemPrompt', self.prompt)
  return self
}

/** One `startActivation` call the subagent double accepted. */
export interface StartedChild {
  readonly provider: string
  readonly label: string
  readonly parent: Agent
  readonly prompt: readonly ContentBlock[]
  readonly persona?: string
  readonly agentOptions?: Record<string, unknown>
  /** DSH 0.2.1 result-delivery policy the team asks for. */
  readonly delivery?: string
}

/** One queued delivery the subagent double accepted. */
export interface FollowupDelivery {
  readonly parentId: string
  readonly childId: string
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

/** The `ctx.subagents` double: records every continuable operation. */
export class FakeSubagents {
  readonly started: StartedChild[] = []
  readonly followups: FollowupDelivery[] = []
  readonly interrupted: string[] = []
  /** Next child id handed out; the team never chooses one itself. */
  nextChildId = 'child-1'
  /** When set, `startActivation` rejects with it. */
  failStart: Error | undefined
  /** Runs while a start is in flight, so a test can observe the composition window. */
  onStart: ((childId: SessionIdType) => void) | undefined
  publishChild: ((childId: SessionIdType, parentId: SessionIdType, options?: Record<string, unknown>) => void) | undefined

  async startActivation(spec: {
    provider: string
    label: string
    request: { parent: Agent; prompt: ContentBlock[]; persona?: string; agentOptions?: Record<string, unknown> }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ childId: SessionIdType; messageId: string }> {
    if (this.failStart !== undefined) throw this.failStart
    const childId = SessionId(this.nextChildId)
    this.started.push({
      provider: spec.provider,
      label: spec.label,
      parent: spec.request.parent,
      prompt: spec.request.prompt,
      ...spec.request.persona !== undefined ? { persona: spec.request.persona } : {},
      ...spec.request.agentOptions !== undefined ? { agentOptions: spec.request.agentOptions } : {},
      delivery: spec.delivery,
    })
    this.onStart?.(childId)
    this.publishChild?.(childId, spec.request.parent.id, spec.request.agentOptions)
    return await Promise.resolve({ childId, messageId: `m-${childId}` })
  }

  async [deliverSubagentPrompt](
    parent: Agent,
    childId: SessionIdType,
    content: ContentBlock[],
    source: MessageSource,
    _signal: AbortSignal,
  ): Promise<string> {
    this.followups.push({
      parentId: parent.id,
      childId,
      content,
      source,
    })
    return await Promise.resolve(`m-${this.followups.length}`)
  }

  interrupt(targetSessionId: SessionIdType): void {
    this.interrupted.push(targetSessionId)
  }

}

/** The `ctx.agents` double: a live registry backed by a map. */
export class FakeAgents {
  private readonly byId = new Map<string, FakeAgent>()

  constructor(private readonly ctx?: Context) {}

  add(agent: FakeAgent): FakeAgent {
    this.byId.set(agent.id, agent)
    this.ctx?.emit('agent/created', { agent: agent.agent, source: 'startup' })
    return agent
  }

  remove(id: string): void {
    const agent = this.byId.get(id)
    if (agent === undefined) return
    this.byId.delete(id)
    this.ctx?.emit('agent/disposed', { agent: agent.agent })
  }

  get(id: string): Agent | undefined {
    return this.byId.get(id)?.agent
  }

  getFake(id: string): FakeAgent | undefined {
    return this.byId.get(id)
  }

  list(): Agent[] {
    return [...this.byId.values()].map(agent => agent.agent)
  }
}

/** The `ctx.llm` double: the provider directory and the model-info read the team validates against. */
export class FakeLlm {
  /** Route pairs `resolveModelInfo` was asked about, in call order. */
  readonly resolved: Array<{ provider: string; model: string }> = []

  constructor(
    private readonly efforts: readonly string[],
    private readonly providers: readonly string[] = ['deepseek'],
  ) {}

  listProviders(): Array<{ id: string; name: string }> {
    return this.providers.map(id => ({ id, name: id }))
  }

  async resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: { id: string }[] } }> {
    this.resolved.push({ provider, model })
    return await Promise.resolve(
      this.efforts.length === 0 ? {} : { reasoning: { efforts: this.efforts.map(id => ({ id })) } },
    )
  }
}

/** One tool registration a scoped registry double accepted. */
export interface RegisteredTool {
  readonly name: string
  readonly definition: { readonly name: string }
}

/** The narrow call view a guard sees in this double: name plus its agent. */
export interface FakeGuardExecution {
  readonly name: string
  readonly agent?: unknown
}

/** One `tools.restrict()` filter a scoped registry double accepted. */
export interface FakeToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** The `ctx.tools` double: registration, guards, and exact-disposer semantics. */
export class FakeTools {
  readonly registered: RegisteredTool[] = []
  /** Monotonic guards, in registration order; the first denial wins. */
  readonly guards: Array<(execution: FakeGuardExecution) => string | undefined> = []
  /**
   * Global (inherited) tool names this scope can see. Registrations made
   * through this double are scope-local, exactly like the real runtime's own
   * layer — which is why {@link restrict} never touches them.
   */
  readonly inherited = new Set<string>()
  /** Restrictions in registration order; they intersect. */
  readonly restrictions: FakeToolRestriction[] = []

  register(definition: { name: string }): () => void {
    const entry: RegisteredTool = { name: definition.name, definition }
    this.registered.push(entry)
    return () => {
      const index = this.registered.indexOf(entry)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }

  /**
   * The `ToolRuntime.get` seam as one scope sees it: an own registration wins,
   * an inherited name has to survive every restriction, and a restricted-away
   * global reads as absent.
   */
  get(name: string): RegisteredTool | undefined {
    const own = this.registered.find(tool => tool.name === name)
    if (own !== undefined) return own
    if (!this.inherited.has(name)) return undefined
    const admitted = this.restrictions.every(filter =>
      (filter.allow === undefined || filter.allow.includes(name))
      && (filter.deny === undefined || !filter.deny.includes(name)))
    return admitted ? { name, definition: { name } } : undefined
  }

  /**
   * The `ToolRuntime.restrict` seam, including its failure contract: a filter
   * naming a tool this scope cannot see throws, so a caller that fails to
   * probe for the tool is caught here rather than in production.
   */
  restrict(filter: FakeToolRestriction): () => void {
    const names = [...filter.allow ?? [], ...filter.deny ?? []]
    if (names.length === 0) throw new Error('FakeTools.restrict({}) is a no-op')
    const unknown = names.filter(name => !this.inherited.has(name))
    if (unknown.length > 0) throw new Error(`FakeTools.restrict() names unknown global tool ${unknown.join(', ')}`)
    const entry: FakeToolRestriction = {
      ...filter.allow === undefined ? {} : { allow: [...filter.allow] },
      ...filter.deny === undefined ? {} : { deny: [...filter.deny] },
    }
    this.restrictions.push(entry)
    return () => {
      const index = this.restrictions.indexOf(entry)
      if (index >= 0) this.restrictions.splice(index, 1)
    }
  }

  /**
   * The `ToolRuntime.guard` seam, narrowed to what a guard reads here. The
   * real pipeline calls it with a `ToolExecution`; a double passing
   * `{ name, agent }` satisfies every team-mode guard.
   */
  guard(guard: (execution: FakeGuardExecution) => string | undefined): () => void {
    this.guards.push(guard)
    return () => {
      const index = this.guards.indexOf(guard)
      if (index >= 0) this.guards.splice(index, 1)
    }
  }
}

/** The `ctx.systemPrompt` double: keeps the section's live text callback. */
export class FakeSystemPrompt {
  readonly sections: Array<{ name: string; order: number; text: () => string }> = []

  section(spec: { name: string; order: number; text: () => string }): () => void {
    this.sections.push(spec)
    return () => {
      const index = this.sections.indexOf(spec)
      if (index >= 0) this.sections.splice(index, 1)
    }
  }
}

/** Sequence numbers are per-log, so one counter per builder call site is enough. */
let seq = 0

/**
 * Build one `tool/result` event carrying a team fact through `meta`.
 * @param meta - the presentation meta the team tool projected.
 * @param options - `error` marks the call as failed, `time` stamps the row.
 * @returns the committed event.
 */
export function toolResultEvent(meta: unknown, options: {
  readonly error?: { name: string; code: string }
  readonly time?: number
} = {}): SessionEvent {
  seq += 1
  return {
    type: 'tool/result',
    seq,
    time: options.time ?? 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: { id: `r${seq}`, role: 'user', content: [{ type: 'tool_result', callId: `c${seq}`, content: [] }] },
      ...options.error !== undefined ? { error: options.error } : {},
      meta,
    },
  } as unknown as SessionEvent
}

/**
 * Build one `user/message` event as a delivery with the given source.
 * @param source - the durable attribution the delivery carried.
 * @param text - the message text.
 * @param time - epoch ms stamped on the row.
 * @returns the committed event.
 */
export function userMessageEvent(source: MessageSource, text: string, time?: number): SessionEvent {
  seq += 1
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  return {
    type: 'user/message',
    seq,
    time: time ?? 1_700_000_000_000 + seq,
    data: message,
  } as unknown as SessionEvent
}

/**
 * Build one `tool/ptc-dispatch` event — the PTC-mode log record of a
 * nested tool call (name + arguments + rendered content, no meta).
 * @param name - the dispatched tool's name.
 * @param args - the sibling-parsed arguments the record carried.
 * @param content - the rendered text or content blocks the tool produced.
 * @param options - `isError` marks the call failed, `time` stamps the row.
 * @returns the committed event.
 */
export function codeDispatchEvent(name: string, args: Record<string, unknown>, content: string | readonly ContentBlock[], options: {
  readonly isError?: boolean
  readonly time?: number
} = {}): SessionEvent {
  seq += 1
  return {
    type: 'tool/ptc-dispatch',
    seq,
    time: options.time ?? 1_700_000_000_000 + seq,
    data: {
      rootCallId: 'root-1',
      parentCallId: 'root-1',
      subCallId: 'root-1:ptc:' + String(seq),
      name,
      arguments: args,
      isError: options.isError === true,
      content: typeof content === 'string' ? (content === '' ? [] : [{ type: 'text', text: content }]) : content,
    },
  } as unknown as SessionEvent
}

/** The `ctx.commands` double: keeps every registered definition, exact disposers. */
export class FakeCommands {
  readonly registered: CommandDefinition[] = []

  register(definition: CommandDefinition): () => void {
    this.registered.push(definition)
    return () => {
      const index = this.registered.indexOf(definition)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }
}

/** A tool execution context double: the acting agent plus a live signal. */
export function fakeExec(agent: FakeAgent): { agent: Agent; signal: AbortSignal } {
  return { agent: agent.agent, signal: new AbortController().signal }
}

/**
 * One session header, handed to a projection unit's `init`. The team shape
 * starts empty for every session, so the double carries nothing but identity.
 */
export function testHeader(id = 'session-1'): SessionHeader {
  return { version: 4, id: SessionId(id), createdAt: 1_700_000_000_000, isSeeded: false }
}
