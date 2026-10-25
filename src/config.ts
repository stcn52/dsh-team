/**
 * Deployment configuration for the team row. Every value is a cordis.yml knob;
 * this plugin holds no hardcoded tunable.
 *
 * @module dsh-team/config
 */

import z from '@deepseek-ai/schemastery'

/** Validated team configuration. */
export interface TeamConfig {
  /** `ctx.subagents` provider used to materialize teammates (the base bundle registers `spawn`). */
  readonly provider: string
  /** Ceiling on live roster size for one leader. */
  readonly maxTeammates: number
  /** Mailbox feed length kept in the durable fold and served to the panel. */
  readonly maxRecentMessages: number
  /**
   * Relays one teammate-started conversation may take before the mailbox
   * refuses another peer delivery. Escalating to the leader is never refused,
   * so the budget converges a peer exchange instead of ending the work.
   */
  readonly maxChainHops: number
  /** Messages one ordered member pair may exchange within a single chain. */
  readonly maxChainRoundTrips: number
  /** Notes one workspace area (the shared board, or one private pad) may hold. */
  readonly maxWorkspaceEntries: number
  /** Longest single note body. */
  readonly maxNoteChars: number
  /**
   * Default LLM provider route for a teammate the leader does not address
   * explicitly. Empty inherits the leader's own route. Set it together with
   * {@link teammateModel} to run every teammate on another route — a locally
   * served model, for instance — without repeating the route on every spawn.
   */
  readonly teammateProvider: string
  /** Default model id paired with {@link teammateProvider}; empty inherits the leader's. */
  readonly teammateModel: string
}

/**
 * The row's config schema; the loader validates before the service is built.
 * Every key is defaulted, so a deployment may add the row with no options at
 * all — the input type stays partial while the validated output is complete.
 */
export const Config: z<Partial<TeamConfig>, TeamConfig> = z.object({
  provider: z.string().default('spawn'),
  maxTeammates: z.number().step(1).min(1).max(64).default(8),
  maxRecentMessages: z.number().step(1).min(1).max(1000).default(50),
  maxChainHops: z.number().step(1).min(1).max(64).default(4),
  maxChainRoundTrips: z.number().step(1).min(1).max(64).default(2),
  maxWorkspaceEntries: z.number().step(1).min(1).max(500).default(32),
  maxNoteChars: z.number().step(1).min(200).max(200_000).default(4000),
  teammateProvider: z.string().default(''),
  teammateModel: z.string().default(''),
})
