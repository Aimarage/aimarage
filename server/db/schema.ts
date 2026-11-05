import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { OAuthApp, SocialConn } from '../lib/platforms/types'
import type { ApiPerm } from '../../shared/utils/api-perms'
import type { KnownRelease } from '../../shared/utils/release-focus'
import { CATEGORIES, CHANNEL_STATUSES, DRAFT_KINDS, DRAFT_STATUSES, PRIOS, ROLES, STATUSES, type Kpi } from '../../shared/utils/domain'
import type { SubRules } from '../../shared/utils/subreddit'
import type { TaskService } from '../../shared/utils/service'

export const memberRole = pgEnum('member_role', ROLES)
export const taskCategory = pgEnum('task_category', CATEGORIES)
export const taskStatus = pgEnum('task_status', STATUSES)
export const taskPrio = pgEnum('task_prio', PRIOS)
export const draftKind = pgEnum('draft_kind', DRAFT_KINDS)
export const draftStatus = pgEnum('draft_status', DRAFT_STATUSES)
export const channelStatus = pgEnum('channel_status', CHANNEL_STATUSES)
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'done', 'failed', 'skipped'])
export const runStatus = pgEnum('run_status', ['running', 'ok', 'error', 'skipped'])
export const actorType = pgEnum('actor_type', ['user', 'agent', 'system', 'mcp'])
export const projectMode = pgEnum('project_mode', ['fixed', 'focus', 'nonfocus', 'each'])

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const ts = (name: string) => timestamp(name, { withTimezone: true })

export type LlmProvider = 'phala' | 'near' | 'cerebras' | 'scaleway' | 'ollama' | 'mistral' | 'anthropic' | 'custom'

export interface StoredLlmKey {
  enc: string
  hint: string
  baseUrl: string
  setAt: string
}

export interface LlmSettings {
  provider?: LlmProvider | 'openai'
  baseUrl?: string
  key?: StoredLlmKey
  model?: string
  modelFast?: string
  reasoning?: boolean
  strong?: StrongLlmSettings
}

export interface StrongLlmSettings {
  enabled?: boolean
  provider?: LlmProvider
  baseUrl?: string
  model?: string
  key?: StoredLlmKey
}

// Eigener KI-Schlüssel im gehosteten Betrieb: nur Anbieter aus der festen Liste, keine eigene Adresse.
export interface OwnLlmSettings {
  provider?: string
  model?: string
  modelFast?: string
  key?: StoredLlmKey
  error?: { code: 'auth' | 'quota' | 'model', message: string, at: string, until?: string | null }
}

export interface WorkspaceSettings {
  upgrades?: string[]
  llm?: LlmSettings
  llmEu?: boolean
  ownLlm?: OwnLlmSettings
  social?: { provider?: 'zernio' | 'uploadpost', key?: StoredLlmKey, accounts?: { id: string, platform: string, name: string, profileId: string | null, profileName: string | null, connectedAt?: string }[], profiles?: { id: string, name: string }[], checkedAt?: string, hosted?: { profileId: string, at: string } }
  briefingTime?: string
  selfPerDay?: number
  approvalsPerDay?: number
  timeBudget?: Record<string, number>
  agentEnabled?: boolean
  autoStrategy?: boolean
  publishLive?: boolean
  sendLive?: boolean
  connections?: SocialConn[]
  apps?: Partial<Record<string, OAuthApp>>
  oauthStates?: { state: string, provider: string, projectId: string | null, verifier?: string, at: string }[]
  mcpApprove?: McpApproveSettings
  aiReviewer?: { enabled?: boolean, ask?: boolean, by?: string, at?: string }
  socialEnvFallback?: boolean
  outboundLocked?: boolean
  subreddits?: Record<string, SubRules>
}

export interface McpApproveSettings {
  enabled?: boolean
  kinds?: string[]
  delayMin?: number
  perDay?: number
  offProjects?: string[]
}

export interface UserPrefs {
  calView?: 'day' | 'week' | 'month'
  tasksView?: 'list' | 'board'
  lastProject?: string
  passkeySnoozedUntil?: string
  firstStepsHidden?: boolean
  // Tagesmail abbestellt (Profil oder Abmeldelink in der Mail), Standard: an.
  morningMailOff?: boolean
}

export type AutonomyLevel = 'approve' | 'auto' | 'auto_report'
export type AutonomyKind = 'social' | 'content' | 'verzeichnis' | 'mail' | 'community' | 'outreach'

export interface ProjectSetup {
  state?: 'onboarding' | 'ready'
  folder?: string | null
  site?: { url: string, title?: string | null, description?: string | null, pages?: { url: string, title: string | null }[], fetchedAt?: string, error?: string | null } | null
  analysis?: StrategyAnalysis | null
  plan?: 'agent' | null
  budget?: string | null
  social?: { profileIds?: string[], accountIds?: string[] } | null
  mail?: ProjectMail | null
  pacing?: { perPlatformPerDay?: number | null } | null
  draftAhead?: number | null
  facts?: { known?: string[], avoid?: string[] } | null
  blog?: string | null
  blogApi?: ProjectBlogApi | null
  stats?: ProjectStats | null
  google?: ProjectGoogle | null
  bing?: ProjectBing | null
  trustAsked?: Partial<Record<AutonomyKind, string>> | null
  feeds?: ProjectFeed[] | null
  geo?: ProjectGeo | null
  client?: { okApproves?: boolean } | null
  preview?: { posts: { channel: string, text: string }[] } | null
  listening?: ProjectListening | null
  progress?: { steps: { key: 'site' | 'folder' | 'audiences' | 'competitors' | 'channels' | 'keywords' | 'strategy', state: 'wait' | 'run' | 'ok' | 'skip' | 'error', note?: string | null }[], done: boolean, proposalId?: string | null }
  rethinkPlan?: RethinkPlan | null
  blockedPlatforms?: string[] | null
}

export interface RethinkPlan {
  strategyId: string
  from: string
  to: string
  tasks: { date: string, time: string | null, channel: string, title: string, place: string | null, brief: string | null }[]
  drop: string[]
}

export interface ProjectListening {
  mode?: 'off' | 'suggest' | 'auto'
  pausedUntil?: string | null
  pauseReason?: string | null
  terms?: { queries: string[], tags: string[], at: string } | null
  seen?: string[]
  notif?: Record<string, string>
  lastRun?: string | null
  convo?: Partial<Record<'bluesky' | 'mastodon' | 'x' | 'threads' | 'tiktok' | 'youtube', boolean>> | null
  voices?: { list: ListenVoice[], at: string | null } | null
  tone?: { picked?: { chosen: string, others: string[], at: string }[], rejected?: { text: string, reason: string | null, at: string }[] } | null
  braveDay?: string | null
}

export interface ListenVoice {
  platform: 'bluesky' | 'mastodon' | 'x' | 'threads' | 'tiktok' | 'youtube'
  handle: string
  name?: string | null
  followers?: number | null
  id?: string | null
  pinned?: boolean
  blocked?: boolean
  source: 'analyse' | 'ki' | 'suche' | 'hand'
}

export interface ProjectFeed {
  url: string
  title?: string | null
  prefix?: string | null
  addedAt: string
  syncedAt?: string | null
  error?: string | null
  newest?: string | null
}

export interface ProjectGeo {
  questions: string[]
  generatedAt?: string | null
  editedAt?: string | null
}

export interface GeoAnswer {
  question: string
  model: string
  label: string
  mentioned: boolean
  position: number | null
  competitors: string[]
  error?: string | null
}

export interface GeoWeb {
  question: string
  rank: number | null
  top: string[]
  error?: string | null
}

export interface GeoSummary {
  asked: number
  mentioned: number
  models: string[]
  webAsked: number
  webHits: number
  competitors: string[]
}

export interface ProjectMail {
  imap: { host: string, port: number, secure: boolean, user: string }
  smtp: { host: string, port: number, secure: boolean, user: string }
  from: string
  secret: { enc: string, hint: string, setAt: string }
  checkedAt?: string | null
  error?: string | null
  lastUid?: number | null
  uidValidity?: string | null
  lastSync?: string | null
  markSeen?: boolean | null
  rules?: Record<string, MailCategory> | null
}

export type MailCategory = 'antwort' | 'wichtig' | 'info' | 'newsletter' | 'spam'

export interface ProjectBlogApi {
  type?: 'aimarage' | 'wordpress' | 'webflow' | 'git'
  url: string
  user?: string | null
  status?: 'publish' | 'draft'
  category?: number | null
  collectionId?: string | null
  fields?: { title: string, slug: string, body: string, description?: string | null } | null
  git?: ProjectBlogGit | null
  secret?: { enc: string, hint: string, setAt: string } | null
  checkedAt?: string | null
  error?: string | null
  lastPublish?: string | null
  skipLangs?: string[] | null
}

export interface ProjectBlogGit {
  provider: 'github' | 'gitlab'
  base?: string | null
  repo: string
  branch: string
  dir: string
  file: string
  publicUrl: string
  imageDir?: string | null
}

export interface ProjectStats {
  mode?: 'api' | 'counter' | null
  url: string
  site?: string | null
  campaignPrefix?: string | null
  secret?: { enc: string, hint: string, setAt: string } | null
  checkedAt?: string | null
  error?: string | null
  lastSync?: string | null
}

export interface ProjectGoogle {
  secret?: { enc: string, hint: string, setAt: string } | null
  property?: string | null
  connectedAt?: string | null
  lastSync?: string | null
  error?: string | null
}

export interface ProjectBing {
  site?: string | null
  off?: boolean
  lastSync?: string | null
  error?: string | null
}

export interface StrategyAnalysis {
  positioning?: string
  audiences?: string[]
  competitors?: { name: string, url?: string | null, note?: string | null }[]
  communities?: string[]
  keywords?: string[]
  channels?: string[]
  note?: string | null
}

export interface StrategyChannel {
  key: string
  name: string
  category: string
  why: string
  goalIds: string[]
  weight: number
  base?: number
  days: string[]
  time?: string | null
  active: boolean
  places?: string[]
  topics?: string[]
}

export interface StrategyChange {
  channelKey: string
  name: string
  change: 'more' | 'less' | 'pause' | 'resume' | 'new' | 'remove'
  from?: number | null
  to?: number | null
  reason: string
  channel?: StrategyChannel
}

export interface WorkspaceLimits {
  projects?: number | null
  members?: number | null
  accounts?: number | null
  llmEurMonth?: number | null
  storageMb?: number | null
  strongModel?: boolean | null
  mcp?: boolean | 'read' | null
  clientLinks?: boolean | null
  onePerPlatform?: boolean | null
  socialAccounts?: number | null
  braveCallsPerDay?: number | null
  servicesEurMonth?: number | null
}

export interface FocusPlan {
  fixed?: Record<string, string | null>
  rotation?: string[]
  rotationStartWeek?: number
}

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/Vienna'),
  locale: text('locale').notNull().default('de'),
  plan: text('plan').notNull().default('selfhost'),
  demo: boolean('demo').notNull().default(false),
  settings: jsonb('settings').$type<WorkspaceSettings>().notNull().default({}),
  limits: jsonb('limits').$type<WorkspaceLimits>(),
  pausedAt: ts('paused_at'),
  deletedAt: ts('deleted_at'),
  previewUsedAt: ts('preview_used_at'),
  storageBytes: bigint('storage_bytes', { mode: 'number' }),
  storageCountedAt: ts('storage_counted_at'),
  createdAt: createdAt(),
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  locale: text('locale').notNull().default('de'),
  prefs: jsonb('prefs').$type<UserPrefs>().notNull().default({}),
  calendarToken: text('calendar_token'),
  webauthnUserId: text('webauthn_user_id').notNull().default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`),
  emailVerifiedAt: ts('email_verified_at'),
  createdAt: createdAt(),
  lastLoginAt: ts('last_login_at'),
}, t => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`), uniqueIndex('users_calendar_token_uq').on(t.calendarToken), uniqueIndex('users_webauthn_user_id_uq').on(t.webauthnUserId)])

export type SessionMethod = 'password' | 'code' | 'passkey'
export type SessionClient = 'web' | 'app'

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  method: text('method').$type<SessionMethod>().notNull().default('password'),
  userAgent: text('user_agent').notNull().default(''),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  stepUpAt: ts('step_up_at'),
  client: text('client').$type<SessionClient>().notNull().default('web'),
  deviceName: text('device_name').notNull().default(''),
}, t => [index('sessions_user_idx').on(t.userId)])

export type PushEnv = 'production' | 'sandbox'

// Push-Empfänger der App: gehört zu einer App-Sitzung (Abmelden oder Widerrufen löscht ihn mit).
export const appDevices = pgTable('app_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull().default('ios'),
  pushToken: text('push_token').notNull(),
  pushEnv: text('push_env').$type<PushEnv>().notNull().default('production'),
  locale: text('locale'),
  lastPushAt: ts('last_push_at'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [uniqueIndex('app_devices_token_uq').on(t.pushToken), uniqueIndex('app_devices_session_uq').on(t.sessionId), index('app_devices_ws_idx').on(t.workspaceId)])

// Was schon per Push gemeldet wurde (je Person), damit nichts doppelt kommt.
export const pushSent = pgTable('push_sent', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  sentAt: ts('sent_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.key] })])

export type AuthCodePurpose = 'login' | 'email_change' | 'step_up' | 'delete_workspace'

export const authCodes = pgTable('auth_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  purpose: text('purpose').$type<AuthCodePurpose>().notNull(),
  target: text('target').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
  createdAt: createdAt(),
}, t => [index('auth_codes_target_idx').on(t.purpose, t.target, t.createdAt), index('auth_codes_expires_idx').on(t.expiresAt)])

export const passkeys = pgTable('passkeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: jsonb('transports').$type<string[]>().notNull().default([]),
  deviceType: text('device_type').notNull().default('singleDevice'),
  backedUp: boolean('backed_up').notNull().default(false),
  name: text('name').notNull(),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
}, t => [index('passkeys_user_idx').on(t.userId)])

export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  challenge: text('challenge').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'register' | 'login' | 'step_up'>().notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
}, t => [index('webauthn_challenges_expires_idx').on(t.expiresAt)])

export const memberships = pgTable('memberships', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: memberRole('role').notNull().default('member'),
  createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.workspaceId, t.userId] })])

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  color: text('color').notNull().default('blue'),
  icon: text('icon').notNull(),
  url: text('url'),
  description: text('description'),
  tonality: text('tonality'),
  rules: text('rules'),
  languages: jsonb('languages').$type<string[]>().notNull().default(['de']),
  kpis: jsonb('kpis').$type<Kpi[]>().notNull().default([]),
  setup: jsonb('setup').$type<ProjectSetup>().notNull().default({}),
  autonomy: jsonb('autonomy').$type<Partial<Record<AutonomyKind, AutonomyLevel>>>().notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
}, t => [uniqueIndex('projects_ws_slug_uq').on(t.workspaceId, t.slug)])

export const projectMembers = pgTable('project_members', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: memberRole('role').notNull().default('member'),
}, t => [primaryKey({ columns: [t.projectId, t.userId] })])

export const projectMemory = pgTable('project_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('fakt'),
  text: text('text').notNull(),
  createdAt: createdAt(),
})

export const goals = pgTable('goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  target3m: text('target_3m'),
  target12m: text('target_12m'),
  metricKey: text('metric_key'),
  mode: text('mode').$type<'sum' | 'last' | 'month'>().notNull().default('sum'),
  targetValue: numeric('target_value', { mode: 'number' }),
  startDate: date('start_date'),
  deadline: date('deadline'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
})

export const strategies = pgTable('strategies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  status: text('status').$type<'vorschlag' | 'aktiv' | 'abgeloest' | 'verworfen'>().notNull().default('vorschlag'),
  kind: text('kind').$type<'initial' | 'review' | 'chat' | 'manual' | 'rethink' | 'release'>().notNull().default('initial'),
  summary: text('summary'),
  channels: jsonb('channels').$type<StrategyChannel[]>().notNull().default([]),
  changes: jsonb('changes').$type<StrategyChange[]>().notNull().default([]),
  byAgent: boolean('by_agent').notNull().default(true),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, t => [index('strategies_project_idx').on(t.projectId, t.version)])

export type StrategyWeekDimension = 'gesamt' | 'kanal' | 'plattform' | 'format' | 'uhrzeit'

export const strategyWeeks = pgTable('strategy_weeks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  strategyId: uuid('strategy_id').references(() => strategies.id, { onDelete: 'set null' }),
  version: integer('version').notNull().default(0),
  week: date('week').notNull(),
  dimension: text('dimension').$type<StrategyWeekDimension>().notNull(),
  key: text('key').notNull().default(''),
  posts: integer('posts').notNull().default(0),
  measured: integer('measured').notNull().default(0),
  reach: numeric('reach', { mode: 'number' }).notNull().default(0),
  interactions: numeric('interactions', { mode: 'number' }).notNull().default(0),
  clicks: numeric('clicks', { mode: 'number' }).notNull().default(0),
  visits: integer('visits').notNull().default(0),
  signups: integer('signups').notNull().default(0),
  purchases: integer('purchases').notNull().default(0),
  costEur: numeric('cost_eur', { mode: 'number' }).notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [uniqueIndex('strategy_weeks_uq').on(t.projectId, t.week, t.version, t.dimension, t.key), index('strategy_weeks_ws_idx').on(t.workspaceId)])

export type ExperimentVariable = 'uhrzeit' | 'format' | 'kanal' | 'thema' | 'takt' | 'massnahme'
export type ExperimentStatus = 'vorschlag' | 'laeuft' | 'ausgewertet' | 'abgebrochen' | 'verworfen'
export type ExperimentMetric = 'interaktionen' | 'reichweite' | 'klicks' | 'besuche' | 'anmeldungen'
export type ExperimentDecision = 'behalten' | 'verwerfen' | 'verlaengern'

export interface ExperimentArmResult {
  posts: number
  mean: number
}

export interface ExperimentResult {
  a: ExperimentArmResult
  b: ExperimentArmResult
  diff: number | null
  verdict: 'besser' | 'schlechter' | 'gleich' | 'zu_wenig'
  at: string
}

export const experiments = pgTable('experiments', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').$type<ExperimentStatus>().notNull().default('vorschlag'),
  hypothesis: text('hypothesis').notNull(),
  variable: text('variable').$type<ExperimentVariable>().notNull(),
  channelKey: text('channel_key'),
  platform: text('platform'),
  variantA: text('variant_a').notNull(),
  variantB: text('variant_b').notNull(),
  metric: text('metric').$type<ExperimentMetric>().notNull().default('interaktionen'),
  minPosts: integer('min_posts').notNull().default(3),
  startDate: date('start_date'),
  endDate: date('end_date'),
  extensions: integer('extensions').notNull().default(0),
  strategyId: uuid('strategy_id').references(() => strategies.id, { onDelete: 'set null' }),
  result: jsonb('result').$type<ExperimentResult>(),
  decision: text('decision').$type<ExperimentDecision>(),
  byAgent: boolean('by_agent').notNull().default(true),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, t => [
  index('experiments_project_idx').on(t.projectId, t.createdAt),
  uniqueIndex('experiments_one_open_uq').on(t.projectId).where(sql`status in ('vorschlag', 'laeuft')`),
])

export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  experimentId: uuid('experiment_id').references(() => experiments.id, { onDelete: 'set null' }),
  variable: text('variable').$type<ExperimentVariable>().notNull(),
  channelKey: text('channel_key'),
  winner: text('winner'),
  loser: text('loser'),
  diff: numeric('diff', { mode: 'number' }),
  text: text('text').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, t => [index('insights_project_idx').on(t.projectId, t.createdAt)])

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'project' | 'general' | 'onboarding'>().notNull().default('project'),
  title: text('title'),
  busySince: ts('busy_since'),
  createdAt: createdAt(),
}, t => [index('conversations_ws_idx').on(t.workspaceId, t.projectId)])

export interface MessageCard {
  type: 'project' | 'goals' | 'strategy' | 'task' | 'tasks' | 'draft' | 'overview' | 'approvals'
  id?: string
  data?: Record<string, unknown>
}

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').$type<'user' | 'assistant' | 'tool' | 'step'>().notNull(),
  content: text('content').notNull().default(''),
  toolCalls: jsonb('tool_calls').$type<{ id: string, name: string, arguments: string }[]>(),
  toolCallId: text('tool_call_id'),
  cards: jsonb('cards').$type<MessageCard[]>().notNull().default([]),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [index('messages_conv_idx').on(t.conversationId, t.seq)])

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  group: text('group').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  url: text('url'),
  rules: text('rules'),
  language: text('language'),
  status: channelStatus('status').notNull().default('offen'),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
})

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  focusPlan: jsonb('focus_plan').$type<FocusPlan>().notNull().default({}),
  goal: text('goal'),
  release: jsonb('release').$type<KnownRelease>(),
  createdAt: createdAt(),
})

export const recurrences = pgTable('recurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  projectMode: projectMode('project_mode').notNull().default('fixed'),
  focusOnly: boolean('focus_only').notNull().default(false),
  rule: text('rule').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  category: taskCategory('category').notNull(),
  channel: text('channel'),
  agentStep: text('agent_step'),
  humanStep: text('human_step'),
  assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  dueTime: text('due_time'),
  durationMin: integer('duration_min').notNull().default(30),
  estimateMin: integer('estimate_min'),
  draftKind: draftKind('draft_kind'),
  metric: text('metric'),
  prio: taskPrio('prio').notNull().default('P2'),
  active: boolean('active').notNull().default(true),
  strategyChannel: text('strategy_channel'),
  startDate: date('start_date'),
  untilDate: date('until_date'),
  createdAt: createdAt(),
})

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  recurrenceId: uuid('recurrence_id').references(() => recurrences.id, { onDelete: 'set null' }),
  occurrenceKey: text('occurrence_key'),
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  category: taskCategory('category').notNull(),
  channel: text('channel'),
  language: text('language'),
  dueDate: date('due_date'),
  dueTime: text('due_time'),
  durationMin: integer('duration_min').notNull().default(30),
  estimateMin: integer('estimate_min'),
  prio: taskPrio('prio').notNull().default('P2'),
  status: taskStatus('status').notNull().default('geplant'),
  agentStep: text('agent_step'),
  humanStep: text('human_step'),
  assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  draftKind: draftKind('draft_kind'),
  targetUrl: text('target_url'),
  service: jsonb('service').$type<TaskService>(),
  metric: text('metric'),
  followUpOn: date('follow_up_on'),
  dependsOnId: uuid('depends_on_id'),
  milestone: boolean('milestone').notNull().default(false),
  postedUrl: text('posted_url'),
  strategyChannel: text('strategy_channel'),
  origin: text('origin'),
  releaseOk: boolean('release_ok').notNull().default(false),
  skippedByPlan: boolean('skipped_by_plan').notNull().default(false),
  forClaude: boolean('for_claude').notNull().default(false),
  plannedFor: date('planned_for'),
  experimentId: uuid('experiment_id'),
  experimentArm: text('experiment_arm').$type<'A' | 'B'>(),
  doneAt: ts('done_at'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('tasks_ws_code_uq').on(t.workspaceId, t.code),
  uniqueIndex('tasks_occurrence_uq').on(t.recurrenceId, t.occurrenceKey),
  index('tasks_ws_due_idx').on(t.workspaceId, t.dueDate),
  index('tasks_project_idx').on(t.projectId),
  index('tasks_experiment_idx').on(t.experimentId),
])

export const drafts = pgTable('drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  kind: draftKind('kind').notNull().default('text'),
  subject: text('subject'),
  body: text('body').notNull(),
  recipient: text('recipient'),
  targetUrl: text('target_url'),
  variant: text('variant'),
  status: draftStatus('status').notNull().default('offen'),
  byAgent: boolean('by_agent').notNull().default(false),
  // Text stammt (ganz oder überwiegend) von einer KI: maschinenlesbare Kennzeichnung beim Posten, Blog und Export (Art. 50 Abs. 2 KI-VO).
  aiGenerated: boolean('ai_generated').notNull().default(false),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: ts('approved_at'),
  approvedVia: text('approved_via'),
  releaseAt: ts('release_at'),
  runId: uuid('run_id'),
  platforms: jsonb('platforms').$type<string[]>().notNull().default([]),
  variants: jsonb('variants').$type<Record<string, string>>().notNull().default({}),
  media: jsonb('media').$type<DraftMedia[]>().notNull().default([]),
  createdAt: createdAt(),
}, t => [index('drafts_task_idx').on(t.taskId), uniqueIndex('drafts_task_version_uq').on(t.taskId, t.version)])

export interface DraftMedia {
  id: string
  name: string
  mime: string
  size: number
  file: string
}

export interface PostPlatformResult {
  platform: string
  ok: boolean | null
  url?: string | null
  postId?: string | null
  error?: string | null
  via?: string | null
}

export type SocialPostStatus = 'geplant' | 'laeuft' | 'gepostet' | 'teilweise' | 'fehler' | 'trocken' | 'abgebrochen'

export const socialPosts = pgTable('social_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  profile: text('profile').notNull(),
  platforms: jsonb('platforms').$type<string[]>().notNull().default([]),
  scheduledAt: ts('scheduled_at').notNull(),
  status: text('status').$type<SocialPostStatus>().notNull().default('geplant'),
  mode: text('mode').$type<'manual' | 'auto' | 'auto_report'>().notNull().default('manual'),
  dryRun: boolean('dry_run').notNull().default(false),
  requestId: text('request_id'),
  results: jsonb('results').$type<PostPlatformResult[]>().notNull().default([]),
  error: text('error'),
  checks: integer('checks').notNull().default(0),
  postedAt: ts('posted_at'),
  statsAt: ts('stats_at'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('social_posts_task_idx').on(t.taskId), index('social_posts_ws_idx').on(t.workspaceId, t.status)])

export const mails = pgTable('mails', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  direction: text('direction').$type<'in' | 'out'>().notNull(),
  status: text('status').$type<'empfangen' | 'erledigt' | 'geplant' | 'gesendet' | 'trocken' | 'fehler' | 'abgebrochen'>().notNull().default('empfangen'),
  kind: text('kind').$type<'reply' | 'code' | 'other'>().notNull().default('other'),
  messageId: text('message_id'),
  inReplyTo: text('in_reply_to'),
  fromAddr: text('from_addr'),
  fromName: text('from_name'),
  toAddr: text('to_addr'),
  subject: text('subject'),
  body: text('body'),
  code: text('code'),
  link: text('link'),
  sentAt: ts('sent_at'),
  scheduledAt: ts('scheduled_at'),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  draftId: uuid('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
  mode: text('mode').$type<'manual' | 'auto' | 'auto_report'>(),
  error: text('error'),
  category: text('category').$type<MailCategory>(),
  categoryBy: text('category_by').$type<'regel' | 'ki' | 'mensch'>(),
  note: text('note'),
  createdAt: createdAt(),
}, t => [uniqueIndex('mails_project_msg_uq').on(t.projectId, t.messageId), index('mails_ws_idx').on(t.workspaceId, t.createdAt), index('mails_task_idx').on(t.taskId)])

export const taskNotes = pgTable('task_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  byAgent: boolean('by_agent').notNull().default(false),
  text: text('text').notNull(),
  createdAt: createdAt(),
})

export interface DocumentFact {
  text: string
  saved: boolean
}

export type DocumentStatus = 'neu' | 'fertig' | 'fehler'

export const projectDocuments = pgTable('project_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  file: text('file').notNull(),
  text: text('text').notNull().default(''),
  summary: text('summary'),
  facts: jsonb('facts').$type<DocumentFact[]>().notNull().default([]),
  status: text('status').$type<DocumentStatus>().notNull().default('neu'),
  error: text('error'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [index('project_documents_project_idx').on(t.projectId, t.createdAt)])

export const projectPages = pgTable('project_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  title: text('title'),
  description: text('description'),
  text: text('text').notNull().default(''),
  image: text('image'),
  linkedFrom: text('linked_from'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('project_pages_project_url_uq').on(t.projectId, t.url)])

export const mediaLibrary = pgTable('media_library', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  file: text('file').notNull(),
  description: text('description').notNull().default(''),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  checked: boolean('checked').notNull().default(false),
  source: text('source'),
  usedCount: integer('used_count').notNull().default(0),
  lastUsedAt: ts('last_used_at'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [index('media_library_project_idx').on(t.projectId, t.createdAt)])

export const taskLinks = pgTable('task_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  platform: text('platform'),
  url: text('url').notNull(),
  postedAt: ts('posted_at').notNull().defaultNow(),
  createdAt: createdAt(),
}, t => [uniqueIndex('task_links_task_url_uq').on(t.taskId, t.url), index('task_links_ws_idx').on(t.workspaceId, t.postedAt)])

export type FeedItemStatus = 'aufgabe' | 'alt' | 'eigen' | 'doppelt' | 'ohne_kanal'

export const feedItems = pgTable('feed_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  feedUrl: text('feed_url').notNull(),
  guid: text('guid'),
  link: text('link').notNull(),
  title: text('title'),
  publishedAt: ts('published_at'),
  status: text('status').$type<FeedItemStatus>().notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [uniqueIndex('feed_items_project_link_uq').on(t.projectId, t.link), index('feed_items_project_guid_idx').on(t.projectId, t.guid)])

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  email: text('email'),
  company: text('company'),
  role: text('role'),
  source: text('source'),
  legalBasis: text('legal_basis'),
  consent: boolean('consent').notNull().default(false),
  status: text('status').$type<'neu' | 'kontaktiert' | 'warm' | 'gesperrt'>().notNull().default('neu'),
  notes: text('notes'),
  deleteOn: date('delete_on'),
  createdAt: createdAt(),
})

export const interactions = pgTable('interactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  happenedOn: date('happened_on').notNull(),
  note: text('note'),
})

export const results = pgTable('results', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  metric: text('metric').notNull(),
  value: numeric('value', { mode: 'number' }).notNull(),
  note: text('note'),
  source: text('source').notNull().default('manuell'),
  measuredOn: date('measured_on').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
})

export const metrics = pgTable('metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  day: date('day').notNull(),
  value: numeric('value', { mode: 'number' }).notNull(),
  source: text('source').notNull().default('manuell'),
  createdAt: createdAt(),
}, t => [uniqueIndex('metrics_proj_key_day_uq').on(t.projectId, t.key, t.day)])

export const utmStats = pgTable('utm_stats', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  source: text('source').notNull(),
  medium: text('medium').notNull().default(''),
  campaign: text('campaign').notNull().default(''),
  content: text('content').notNull().default(''),
  path: text('path').notNull().default(''),
  visits: integer('visits').notNull().default(0),
  signups: integer('signups').notNull().default(0),
  interests: integer('interests').notNull().default(0),
  purchases: integer('purchases').notNull().default(0),
  netCents: integer('net_cents').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.projectId, t.day, t.source, t.medium, t.campaign, t.content, t.path] })])

export const searchStats = pgTable('search_stats', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  source: text('source').notNull().default('google'),
  day: date('day').notNull(),
  query: text('query').notNull().default(''),
  page: text('page').notNull().default(''),
  clicks: integer('clicks').notNull().default(0),
  impressions: integer('impressions').notNull().default(0),
  position: numeric('position', { mode: 'number' }).notNull().default(0),
}, t => [primaryKey({ columns: [t.projectId, t.source, t.day, t.query, t.page] })])

export const seoAudits = pgTable('seo_audits', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  checkedAt: ts('checked_at').notNull().defaultNow(),
  pages: integer('pages').notNull().default(0),
  result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
})

export const geoChecks = pgTable('geo_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  week: date('week').notNull(),
  checkedAt: ts('checked_at').notNull().defaultNow(),
  answers: jsonb('answers').$type<GeoAnswer[]>().notNull().default([]),
  web: jsonb('web').$type<GeoWeb[]>().notNull().default([]),
  summary: jsonb('summary').$type<GeoSummary>().notNull(),
  costEur: numeric('cost_eur', { mode: 'number' }).notNull().default(0),
}, t => [uniqueIndex('geo_checks_project_week_uq').on(t.projectId, t.week)])

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  content: jsonb('content').$type<Record<string, unknown>>().notNull().default({}),
  text: text('text'),
  createdAt: createdAt(),
}, t => [uniqueIndex('reports_ws_kind_period_uq').on(t.workspaceId, t.kind, t.periodStart)])

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  job: text('job').notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  status: runStatus('status').notNull().default('running'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  model: text('model'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costEur: numeric('cost_eur', { mode: 'number' }).notNull().default(0),
  ownCostEur: numeric('own_cost_eur', { mode: 'number' }).notNull().default(0),
  summary: text('summary'),
  log: text('log'),
}, t => [index('agent_runs_ws_idx').on(t.workspaceId, t.startedAt)])

export const braveUsage = pgTable('brave_usage', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().default(''),
  day: date('day').notNull(),
  purpose: text('purpose').notNull(),
  calls: integer('calls').notNull().default(0),
  hostedCalls: integer('hosted_calls').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
}, t => [primaryKey({ columns: [t.workspaceId, t.day, t.purpose, t.projectId] })])

export const serviceUsage = pgTable('service_usage', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  service: text('service').notNull(),
  units: integer('units').notNull().default(0),
}, t => [primaryKey({ columns: [t.workspaceId, t.day, t.service] })])

export const activity = pgTable('activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  actor: actorType('actor').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [index('activity_ws_idx').on(t.workspaceId, t.createdAt), index('activity_task_idx').on(t.taskId)])

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
})

export const jobs = pgTable('jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: jobStatus('status').notNull().default('queued'),
  dedupeKey: text('dedupe_key'),
  runAt: ts('run_at').notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lockedAt: ts('locked_at'),
  workerId: text('worker_id'),
  finishedAt: ts('finished_at'),
  lastError: text('last_error'),
  createdAt: createdAt(),
}, t => [uniqueIndex('jobs_dedupe_uq').on(t.dedupeKey), index('jobs_queue_idx').on(t.status, t.runAt)])

export type ClientVerdict = 'ok' | 'change'

export const clientLinks = pgTable('client_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  hint: text('hint').notNull(),
  tokenHash: text('token_hash').notNull(),
  canReport: boolean('can_report').notNull().default(false),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: ts('expires_at'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
}, t => [uniqueIndex('client_links_hash_uq').on(t.tokenHash), index('client_links_project_idx').on(t.projectId)])

export const clientFeedback = pgTable('client_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  linkId: uuid('link_id').references(() => clientLinks.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  verdict: text('verdict').$type<ClientVerdict>().notNull(),
  comment: text('comment'),
  approved: boolean('approved').notNull().default(false),
  createdAt: createdAt(),
}, t => [index('client_feedback_draft_idx').on(t.draftId), index('client_feedback_project_idx').on(t.projectId, t.createdAt)])

export type ApiScope = 'read' | 'write'
export type { ApiPerm } from '../../shared/utils/api-perms'

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  hint: text('hint').notNull(),
  tokenHash: text('token_hash').notNull(),
  scope: text('scope').$type<ApiScope>().notNull().default('read'),
  canApprove: boolean('can_approve').notNull().default(false),
  perms: jsonb('perms').$type<ApiPerm[]>().notNull().default(['read']),
  projectIds: jsonb('project_ids').$type<string[] | null>(),
  expiresAt: ts('expires_at'),
  lastClient: text('last_client'),
  reviewNeeded: boolean('review_needed').notNull().default(false),
  expiryWarnedAt: ts('expiry_warned_at'),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
}, t => [uniqueIndex('api_tokens_hash_uq').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)])

export const mcpCalls = pgTable('mcp_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  tokenId: uuid('token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
  grantId: uuid('grant_id'),
  keyLabel: text('key_label').notNull(),
  client: text('client'),
  ip: text('ip'),
  via: text('via').$type<'mcp' | 'rest'>().notNull().default('mcp'),
  tool: text('tool').notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  project: text('project'),
  args: jsonb('args').$type<Record<string, string>>().notNull().default({}),
  ok: boolean('ok').notNull(),
  denied: boolean('denied').notNull().default(false),
  error: text('error'),
  resultBytes: integer('result_bytes').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  createdAt: createdAt(),
}, t => [index('mcp_calls_ws_idx').on(t.workspaceId, t.createdAt), index('mcp_calls_token_idx').on(t.tokenId, t.createdAt)])

export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  clientUri: text('client_uri'),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
})

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope').$type<ApiScope>().notNull(),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
})

export const oauthGrants = pgTable('oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  clientName: text('client_name').notNull(),
  scope: text('scope').$type<ApiScope>().notNull(),
  accessHash: text('access_hash').notNull(),
  accessExpiresAt: ts('access_expires_at').notNull(),
  refreshHash: text('refresh_hash').notNull(),
  prevRefreshHash: text('prev_refresh_hash'),
  refreshExpiresAt: ts('refresh_expires_at').notNull(),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
}, t => [uniqueIndex('oauth_grants_access_uq').on(t.accessHash), uniqueIndex('oauth_grants_refresh_uq').on(t.refreshHash), index('oauth_grants_user_idx').on(t.userId), index('oauth_grants_prev_idx').on(t.prevRefreshHash)])

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  resetAt: ts('reset_at').notNull(),
}, t => [index('rate_limits_reset_idx').on(t.resetAt)])

export type NotificationChannel = 'mail' | 'push'

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  channels: jsonb('channels').$type<NotificationChannel[]>().notNull().default([]),
  dedupeKey: text('dedupe_key'),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, t => [index('notifications_user_idx').on(t.userId, t.createdAt), index('notifications_ws_idx').on(t.workspaceId, t.createdAt), uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey)])

export type DeletionKind = 'project' | 'workspace' | 'account'

// Protokoll der Löschungen (wer, was, wann), ohne Inhalte und ohne Fremdschlüssel: bleibt nach der Löschung stehen.
export const deletionLog = pgTable('deletion_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').$type<DeletionKind>().notNull(),
  targetId: uuid('target_id').notNull(),
  workspaceId: uuid('workspace_id'),
  actorUserId: uuid('actor_user_id'),
  via: text('via').notNull().default('web'),
  counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [index('deletion_log_created_idx').on(t.createdAt)])
