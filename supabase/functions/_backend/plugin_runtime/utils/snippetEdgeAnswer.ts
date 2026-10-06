import type { Context } from 'hono'
import { updatesAppCacheTag, updatesVersionsCacheTag } from './updatesCacheTag.ts'
import { hasUpdatesPurgeTarget, parseEdgeShareBps } from './updatesEdgeCache.ts'
import { getEnv, isListedLimitedApp } from './utils.ts'

/**
 * Snippet edge answers: the Cloudflare Snippet in front of the plugin workers
 * (cloudflare_workers/snippet) answers the most common plugin requests itself,
 * so they never invoke, and never bill, a worker:
 * - /updates when the device already runs the bundle its channel serves
 *   (`no_new_version_available`)
 * - /stats when the app is a cloud app with a valid plan
 *
 * The worker teaches the snippet. An answer the snippet may repeat carries
 * `X-Capgo-Edge-Fill`; the snippet stores it in the cache of its own data
 * center (the worker runs in a placed region, so the worker's Cache API is not
 * the snippet's) under the app's purge tags, so the existing purge pipeline
 * evicts it on any channel / app / bundle / plan change. The TTL is only the
 * backstop for a lost purge and the delay of the off switch.
 *
 * Stats of answered requests come back through Logpush: every snippet answer
 * carries `X-Capgo-Edge-Stat`, Logpush ships it to R2 and the plugin worker's
 * queue consumer replays it (snippetEdgeReplay.ts).
 *
 * Switch: worker secret `SNIPPET_EDGE_ANSWER` (off | on | N% of devices). Only
 * turn it on once the Logpush -> R2 -> queue pipeline runs, otherwise the
 * stats of answered requests are lost.
 */
export const SNIPPET_EDGE_FILL_HEADER = 'X-Capgo-Edge-Fill'
/** On an update enumeration limit answer: unix seconds until the IP limit resets. */
export const SNIPPET_EDGE_IP_LIMIT_HEADER = 'X-Capgo-Edge-Ip-Limit'
export const SNIPPET_EDGE_ANSWER_DEFAULT_TTL_SECONDS = 900
const SNIPPET_EDGE_ANSWER_MIN_TTL_SECONDS = 10
const SNIPPET_EDGE_ANSWER_MAX_TTL_SECONDS = 3600

interface SnippetFillBase {
  v: 1
  /** Share of devices the snippet answers, in basis points. */
  bps: number
  ttl: number
  /** Cache-Tag value of the snippet entry. */
  tags: string
}

export interface SnippetUpdatesFill extends SnippetFillBase {
  e: 'updates'
  /** Bundle the channel serves: the snippet answers only devices already on it. */
  n: string
  k: string | null
  o: string
  a: boolean
  /** Legacy channel_self store bound: old plugin versions keep the worker path. */
  cs: boolean
}

export interface SnippetStatsFill extends SnippetFillBase {
  e: 'stats'
}

export interface SnippetUpdatesAnswer {
  ownerOrg: string
  allowDeviceCustomId: boolean
  versionName: string
  keyId: string | null
}

/** Stats replay of a snippet-answered request (see snippetEdgeReplay.ts). */
export interface SnippetEdgeReplay {
  endpoint: 'updates' | 'stats'
  updates?: Pick<SnippetUpdatesAnswer, 'ownerOrg' | 'allowDeviceCustomId' | 'versionName'>
}

const replayRequests = new WeakMap<Request, SnippetEdgeReplay>()

/** In-process only: requests built by the replay consumer, never a client request. */
export function markSnippetEdgeReplay(request: Request, replay: SnippetEdgeReplay) {
  replayRequests.set(request, replay)
}

export function getSnippetEdgeReplay(c: Context) {
  return replayRequests.get(c.req.raw)
}

export function getSnippetEdgeAnswerBps(c: Context) {
  // Same interlock as the worker edge cache: without a purge path the
  // snippet entries could only expire with their TTL.
  if (!hasUpdatesPurgeTarget(c))
    return 0
  return parseEdgeShareBps(getEnv(c, 'SNIPPET_EDGE_ANSWER'))
}

export function getSnippetEdgeAnswerTtlSeconds(c: Context) {
  const raw = Number.parseInt(getEnv(c, 'SNIPPET_EDGE_ANSWER_TTL_SECONDS'), 10)
  if (!Number.isFinite(raw))
    return SNIPPET_EDGE_ANSWER_DEFAULT_TTL_SECONDS
  return Math.min(Math.max(raw, SNIPPET_EDGE_ANSWER_MIN_TTL_SECONDS), SNIPPET_EDGE_ANSWER_MAX_TTL_SECONDS)
}

function fillBase(c: Context, appId: string, blockProviderInfraRequests: boolean): SnippetFillBase | null {
  // A replayed request has no snippet in front of it.
  if (getSnippetEdgeReplay(c))
    return null
  // The snippet cannot run the provider IP check or the LIMITED_APPS throttle.
  if (blockProviderInfraRequests || isListedLimitedApp(c, appId))
    return null
  const bps = getSnippetEdgeAnswerBps(c)
  if (bps <= 0)
    return null
  return {
    v: 1,
    bps,
    ttl: getSnippetEdgeAnswerTtlSeconds(c),
    // Both scopes: the answer depends on the channel (main tag) and on the
    // served bundle row (versions tag: deleted, key_id).
    tags: `${updatesAppCacheTag(appId)},${updatesVersionsCacheTag(appId)}`,
  }
}

function setFillHeader(c: Context, fill: SnippetUpdatesFill | SnippetStatsFill) {
  // Version names are free text: keep the header value ASCII.
  c.header(SNIPPET_EDGE_FILL_HEADER, encodeURIComponent(JSON.stringify(fill)))
}

/**
 * Call right before returning `no_new_version_available` from an answer
 * that holds for every device of (app, platform, defaultChannel) on that
 * bundle: no override, no rollout, valid plan (the read-cache contract).
 */
export function setSnippetUpdatesFill(c: Context, appId: string, answer: SnippetUpdatesAnswer, opts: { blockProviderInfraRequests: boolean, legacyChannelSelfStore: boolean }) {
  const base = fillBase(c, appId, opts.blockProviderInfraRequests)
  if (!base)
    return
  setFillHeader(c, {
    ...base,
    e: 'updates',
    n: answer.versionName,
    k: answer.keyId,
    o: answer.ownerOrg,
    a: answer.allowDeviceCustomId,
    cs: opts.legacyChannelSelfStore,
  })
}

/** Call on an all-ok /stats answer of a cloud app with a valid plan. */
export function setSnippetStatsFill(c: Context, appId: string, blockProviderInfraRequests: boolean) {
  const base = fillBase(c, appId, blockProviderInfraRequests)
  if (!base)
    return
  setFillHeader(c, { ...base, e: 'stats' })
}

/**
 * The update enumeration guard lives in the worker's cache. Tell the snippet
 * when an IP is limited, so it stops answering that IP (an up-to-date answer
 * would confirm a guessed bundle name).
 */
export function setSnippetIpLimitHeader(c: Context, resetAtMs: number) {
  if (getSnippetEdgeReplay(c) || getSnippetEdgeAnswerBps(c) <= 0)
    return
  c.header(SNIPPET_EDGE_IP_LIMIT_HEADER, String(Math.ceil(resetAtMs / 1000)))
}
