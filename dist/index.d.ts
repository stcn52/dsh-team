import { _ as Config, a as EMPTY_TEAM_VIEW, c as TeamChain, d as TeamMessageSource, f as TeamMessageView, g as TeamView, h as TeamTaskView, i as foldTeam, l as TeamMemberView, m as TeamTaskStatus, n as TeamFact, o as TEAM_PROJECTION_KEY, p as TeamRelation, r as TeamMemberFact, s as TeamBoardEntryView, t as TeamService, u as TeamMessageKind, v as TeamConfig } from "./service-DD0KY6U2.js";
import { z } from "zod";
import { Context } from "@deepseek-ai/cordis";
import { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
//#region src/errors.d.ts
/**
 * Team failures the model reads back as tool errors. One class with a closed
 * code set: the code is the stable fact, the message is the sentence the model
 * acts on.
 *
 * @module dsh-team/errors
 */
/** Every way a team operation refuses. */
type TeamErrorCode = 'NO_TEAM' | 'LEADER_AWAY' | 'NESTED_TEAM' | 'MAX_TEAMMATES' | 'DUPLICATE_NAME' | 'UNKNOWN_MEMBER' | 'UNKNOWN_TASK' | 'TASK_TITLE_REQUIRED' | 'SELF_MESSAGE' | 'UNAUTHORIZED' | 'UNKNOWN_PROVIDER' | 'MODEL_REQUIRED' | 'UNKNOWN_EFFORT' | 'CHAIN_EXHAUSTED' | 'PING_PONG' | 'REPEATED_MESSAGE' | 'INVALID_NOTE_KEY' | 'NOTE_TOO_LONG' | 'WORKSPACE_FULL' | 'UNKNOWN_NOTE' | 'EMPTY_LEARNING' | 'UNKNOWN_DOSSIER' | 'UNKNOWN_ENTRY';
/** One refused team operation. */
declare class TeamError extends Error {
  readonly code: TeamErrorCode;
  readonly detail?: string | undefined;
  /**
   * @param code - the stable refusal code.
   * @param detail - the caller-specific part appended to the stable sentence.
   */
  constructor(code: TeamErrorCode, detail?: string | undefined);
}
//#endregion
//#region src/projection.d.ts
/**
 * The `team` unit as the registry's client-visible overload takes it: the fold
 * state is also the served value, so `wire` is present rather than optional and
 * its `view` is the identity.
 */
type TeamProjectionUnit = Omit<ProjectionDefinition<'team', TeamView>, 'wire'> & {
  readonly wire: NonNullable<ProjectionDefinition<'team', TeamView>['wire']>;
};
/**
 * Build the projection unit for one deployment's mailbox bound.
 * @param maxRecentMessages - feed ceiling from the row config.
 * @returns the registrable unit.
 */
declare function teamProjection(maxRecentMessages: number): TeamProjectionUnit;
//#endregion
//#region src/workspace.d.ts
/** The shared area's stable id; every other area id is a member's session id. */
declare const SHARED_AREA = "shared";
/** One stored note, whole: the record IS the entity, never a delta. */
declare const entrySchema$1: z.ZodObject<{
  leaderId: z.ZodString;
  area: z.ZodString;
  key: z.ZodString;
  text: z.ZodString;
  authorId: z.ZodString;
  authorName: z.ZodString;
  updatedAt: z.ZodNumber;
}, z.core.$strip>;
/** One stored note. */
type WorkspaceEntry = z.infer<typeof entrySchema$1>;
/** The domain this plugin owns: one table of notes across every team. */
declare const WORKSPACE_DOMAIN: {
  name: string;
  version: number;
  tables: {
    entries: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
      leaderId: string;
      area: string;
      key: string;
      text: string;
      authorId: string;
      authorName: string;
      updatedAt: number;
    }>;
  };
};
/** Who is writing, as the note records them. */
interface NoteAuthor {
  readonly id: string;
  readonly name: string;
}
/**
 * The team workspaces over one open storage domain. One instance serves every
 * team in the process; records carry their own leader and area, so a read is a
 * filter and no two teams can see each other's notes.
 */
declare class TeamWorkspace {
  private readonly config;
  private readonly opening;
  private disposed;
  /**
   * @param ctx - a context whose `storageDomain` is already resolved.
   * @param config - the row config carrying the workspace bounds.
   */
  constructor(ctx: Context, config: TeamConfig);
  /**
   * Read one area of one team's workspace, newest first.
   * @param leaderId - the team's leader session id.
   * @param area - {@link SHARED_AREA} or a member's session id.
   * @returns the notes in that area.
   */
  read(leaderId: string, area: string): Promise<readonly WorkspaceEntry[]>;
  /**
   * Write one note, replacing whatever the key held.
   * @param leaderId - the team's leader session id.
   * @param area - {@link SHARED_AREA} or the author's own session id.
   * @param key - the note's name, as the model gave it.
   * @param text - the whole note body.
   * @param author - who is writing.
   * @param now - epoch ms recorded on the note.
   * @returns the stored note.
   * @throws {TeamError} on an unusable key, an oversized note, or a full area.
   */
  write(leaderId: string, area: string, key: string, text: string, author: NoteAuthor, now: number): Promise<WorkspaceEntry>;
  /**
   * Drop one note.
   * @param leaderId - the team's leader session id.
   * @param area - the area holding it.
   * @param key - the note's name.
   * @throws {TeamError} when no note of that name is in the area.
   */
  remove(leaderId: string, area: string, key: string): Promise<void>;
  /**
   * Drop everything one area holds — a dismissed member's private pad, or a
   * disbanded team's whole workspace.
   * @param leaderId - the team's leader session id.
   * @param area - one area, or undefined for every area of this team.
   */
  clear(leaderId: string, area?: string): Promise<void>;
  /**
   * The shared area as the leader's durable projection carries it: names,
   * attribution, and a one-line preview, never whole note bodies. A private
   * pad is never projected — private means private, including from the panel.
   * @param leaderId - the team's leader session id.
   * @returns the board index, newest first.
   */
  index(leaderId: string): Promise<readonly TeamBoardEntryView[]>;
  /** Release the domain handle; queued writes drain first. */
  dispose(): void;
}
//#endregion
//#region src/dossier.d.ts
/** What one dossier entry may be. `feedback` is the leader's; a member learns lessons and facts. */
declare const kindSchema: z.ZodEnum<{
  lesson: "lesson";
  fact: "fact";
  feedback: "feedback";
}>;
/** One remembered point, whole: the record IS the entity, never a delta. */
declare const entrySchema: z.ZodObject<{
  id: z.ZodString;
  kind: z.ZodEnum<{
    lesson: "lesson";
    fact: "fact";
    feedback: "feedback";
  }>;
  text: z.ZodString;
  evidence: z.ZodString;
  createdAt: z.ZodNumber;
  reinforced: z.ZodNumber;
}, z.core.$strip>;
/** One remembered point. */
type DossierEntry = z.infer<typeof entrySchema>;
/** One entry's kind. */
type DossierKind = z.infer<typeof kindSchema>;
/** The whole career record of one name. */
declare const memberSchema: z.ZodObject<{
  key: z.ZodString;
  name: z.ZodString;
  createdAt: z.ZodNumber;
  updatedAt: z.ZodNumber;
  stats: z.ZodObject<{
    delivered: z.ZodNumber;
    reworks: z.ZodNumber;
  }, z.core.$strip>;
  entries: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
      lesson: "lesson";
      fact: "fact";
      feedback: "feedback";
    }>;
    text: z.ZodString;
    evidence: z.ZodString;
    createdAt: z.ZodNumber;
    reinforced: z.ZodNumber;
  }, z.core.$strip>>;
}, z.core.$strip>;
/** One member's durable record. */
type MemberRecord = z.infer<typeof memberSchema>;
/** The domain this plugin owns: one table of career records across every team. */
declare const DOSSIER_DOMAIN: {
  name: string;
  version: number;
  tables: {
    members: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, {
      key: string;
      name: string;
      createdAt: number;
      updatedAt: number;
      stats: {
        delivered: number;
        reworks: number;
      };
      entries: {
        id: string;
        kind: "lesson" | "fact" | "feedback";
        text: string;
        evidence: string;
        createdAt: number;
        reinforced: number;
      }[];
    }>;
  };
};
/** The evidence line every leader review note carries. */
declare const REVIEW_EVIDENCE = "leader review";
/** What one `learn` call produced. */
interface LearnOutcome {
  /** The entry now held — the reinforced one on a dedup hit, the new one otherwise. */
  readonly entry: DossierEntry;
  /** True when the point was already recorded and only reinforced. */
  readonly deduplicated: boolean;
  /** Entries held after this write, bounds applied. */
  readonly entries: number;
}
/**
 * The member dossiers over one open storage domain. One instance serves every
 * team in the process; records carry their own name key, so a read is a
 * lookup and no two names can collide on one record.
 */
declare class MemberDossiers {
  private readonly config;
  private readonly opening;
  private table;
  private domain;
  private disposed;
  /**
   * @param ctx - a context whose `storageDomain` is already resolved.
   * @param config - the row config carrying the dossier bounds.
   */
  constructor(ctx: Context, config: TeamConfig);
  /**
   * Read one member's whole record.
   * @param name - any spelling of the member's name.
   * @returns the record, or undefined when nobody under that name has written yet.
   */
  read(name: string): Promise<MemberRecord | undefined>;
  /**
   * Record one lesson or fact in the member's own dossier.
   * @param name - the member's name (its own, for a `team_learn` caller).
   * @param spec - kind, the reusable point, and the evidence behind it.
   * @returns the held entry, whether the point was already known, and the new entry count.
   * @throws {TeamError} `EMPTY_LEARNING` on a blank text or a blank evidence line.
   */
  learn(name: string, spec: {
    readonly kind: DossierKind;
    readonly text: string;
    readonly evidence: string;
  }): Promise<LearnOutcome>;
  /**
   * Record one outcome of the member's work. Stats move here and nowhere else.
   * @param name - the reviewed member's name.
   * @param outcome - `accepted` raises delivered, `rework` raises reworks.
   * @param note - optional feedback kept as a dossier entry, evidence fixed to
   *   {@link REVIEW_EVIDENCE}; dedup and bounds apply as in {@link learn}.
   * @returns the whole post-review record.
   */
  review(name: string, outcome: 'accepted' | 'rework', note?: string): Promise<MemberRecord>;
  /**
   * Drop one entry by its id.
   * @param name - the member's name.
   * @param entryId - the id as `team_profile` or the digest showed it.
   * @returns the entries left in the record.
   * @throws {TeamError} `UNKNOWN_DOSSIER` when the name has no record,
   *   `UNKNOWN_ENTRY` when the record holds no such id.
   */
  forget(name: string, entryId: string): Promise<number>;
  /**
   * The digest a member reads every step: stats line, then feedback newest
   * first, then lessons by how often they were re-learned, then facts. Bounded
   * by `maxDossierDigestChars`; entries are named by id so the member can
   * quote the one the leader should forget.
   * @param name - the member's name.
   * @param maxChars - the budget; defaults to the deployment's.
   * @returns the digest, or '' when the name has no record (or the domain has
   *   not finished opening — the next step has it).
   */
  digest(name: string, maxChars?: number): string;
  /**
   * Trim an entry list to both bounds, in the eviction order: count first,
   * then total characters. The last standing entry is never dropped — a
   * bound so small that even one entry does not fit still keeps that entry.
   */
  private evict;
  /** Release the domain handle; queued writes drain first. */
  dispose(): void;
}
//#endregion
//#region src/index.d.ts
declare const name = "team";
/**
 * `tools` and `systemPrompt` are declared although this row registers into
 * agent scopes rather than the root registry: a Loader ordering mistake then
 * fails at load instead of at the next session or teammate.
 */
declare const inject: string[];
/**
 * Compose the team capability: the service, the durable projection unit, the
 * teammate world, the per-session leader tools, the virtual workspaces, the
 * member dossiers, the human `/agent-teams` command, and the authenticated
 * `/api/team/*` channel a panel drives.
 *
 * `commands` is injected softly rather than declared on the row, like
 * `storageDomain`: UI-less compositions ship no command adapter, and the row
 * must load there with every other capability intact.
 *
 * @param ctx - the row's context.
 * @param config - the validated row configuration.
 */
declare function apply(ctx: Context, config: TeamConfig): void;
//#endregion
export { Config, DOSSIER_DOMAIN, type DossierEntry, type DossierKind, EMPTY_TEAM_VIEW, MemberDossiers, type MemberRecord, REVIEW_EVIDENCE, SHARED_AREA, TEAM_PROJECTION_KEY, TeamBoardEntryView, TeamChain, type TeamConfig, TeamError, type TeamErrorCode, type TeamFact, type TeamMemberFact, TeamMemberView, TeamMessageKind, TeamMessageSource, TeamMessageView, TeamRelation, TeamService, TeamTaskStatus, TeamTaskView, TeamView, TeamWorkspace, WORKSPACE_DOMAIN, type WorkspaceEntry, apply, foldTeam, inject, name, teamProjection };