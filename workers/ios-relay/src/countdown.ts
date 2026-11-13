// Informational ActivityKit state. Calendar presentation stays on the iPhone.
import { HttpError, MAX_ALARM_HORIZON_MS, requireObject } from "./http";

export interface Milestone { presentationID: string; kind: "departure" | "start"; targetAtMs: number }
export interface ActivityToken { activityID: string; presentationID: string; pushToken: string }
export interface CountdownSnapshot {
  version: 1; revision: number; pushToStartToken: string | null;
  milestones: Milestone[]; activities: ActivityToken[]; dismissedPresentationIDs: string[];
}
export const COUNTDOWN_WINDOW_MS = 600_000;
const ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64,200}$/;

export function validateCountdown(body: unknown, now: number): CountdownSnapshot {
  requireObject(body, ["version", "revision", "pushToStartToken", "milestones", "activities", "dismissedPresentationIDs"]);
  if (body.version !== 1 || !Number.isSafeInteger(body.revision) || (body.revision as number) <= 0) throw new HttpError(400, "invalid countdown version or revision");
  if (body.pushToStartToken !== null && (typeof body.pushToStartToken !== "string" || !TOKEN.test(body.pushToStartToken))) throw new HttpError(400, "invalid countdown start token");
  if (!Array.isArray(body.milestones) || body.milestones.length > 64 || !Array.isArray(body.activities) || body.activities.length > 16 || !Array.isArray(body.dismissedPresentationIDs) || body.dismissedPresentationIDs.length > 64) throw new HttpError(400, "invalid countdown array bounds");
  const ids = new Set<string>();
  const milestones = body.milestones.map((m: unknown): Milestone => {
    requireObject(m, ["presentationID", "kind", "targetAtMs"]);
    if (typeof m.presentationID !== "string" || !ID.test(m.presentationID) || ids.has(m.presentationID)) throw new HttpError(400, "invalid or duplicate milestone ID");
    ids.add(m.presentationID);
    if (m.kind !== "departure" && m.kind !== "start") throw new HttpError(400, "invalid milestone kind");
    if (!Number.isSafeInteger(m.targetAtMs) || (m.targetAtMs as number) <= 0 || (m.targetAtMs as number) > now + MAX_ALARM_HORIZON_MS) throw new HttpError(400, "invalid milestone time");
    return { presentationID: m.presentationID, kind: m.kind, targetAtMs: m.targetAtMs as number };
  });
  const activityIDs = new Set<string>();
  const activities = body.activities.map((a: unknown): ActivityToken => {
    requireObject(a, ["activityID", "presentationID", "pushToken"]);
    if (typeof a.activityID !== "string" || !/^[\x20-\x7e]{1,200}$/.test(a.activityID) || activityIDs.has(a.activityID)) throw new HttpError(400, "invalid or duplicate activity ID");
    activityIDs.add(a.activityID);
    if (typeof a.presentationID !== "string" || !ID.test(a.presentationID) || typeof a.pushToken !== "string" || !TOKEN.test(a.pushToken)) throw new HttpError(400, "invalid activity token");
    return { activityID: a.activityID, presentationID: a.presentationID, pushToken: a.pushToken };
  });
  const dismissed = body.dismissedPresentationIDs;
  if (dismissed.some(id => typeof id !== "string" || !ID.test(id)) || new Set(dismissed).size !== dismissed.length) throw new HttpError(400, "invalid dismissed IDs");
  return { version: 1, revision: body.revision as number, pushToStartToken: body.pushToStartToken as string | null,
    milestones: milestones.sort(compareMilestones), activities: activities.sort((a,b) => a.activityID.localeCompare(b.activityID)), dismissedPresentationIDs: [...dismissed].sort() };
}
function compareMilestones(a: Milestone, b: Milestone): number {
  return a.targetAtMs - b.targetAtMs || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.presentationID.localeCompare(b.presentationID);
}
export function selectedMilestone(snapshot: CountdownSnapshot, now: number): Milestone | undefined {
  return snapshot.milestones.filter(m => now >= m.targetAtMs - COUNTDOWN_WINDOW_MS && now < m.targetAtMs && !snapshot.dismissedPresentationIDs.includes(m.presentationID)).sort(compareMilestones)[0];
}
interface KnownActivity extends ActivityToken { milestone: Milestone; sentRevision: number; retryAt: number; failures: number; lastTimestamp?: number }
export interface CountdownState {
  snapshot: CountdownSnapshot;
  // Canonical snapshot digest for equal-revision conflicts, independent of token cleanup.
  accepted: string;
  attempted: Record<string, number>;
  activities: Record<string, KnownActivity>;
  ended: Record<string, number>;
  invalidTokens?: string[];
  startedAt?: Record<string, number>;
}
export interface CountdownWork { event: "start" | "update" | "end"; token: string; milestone: Milestone; revision: number; activityID?: string }
export function replaceCountdown(old: CountdownState | undefined, snapshot: CountdownSnapshot, now: number, accepted: string): CountdownState | "stale" | "conflict" {
  if (old && snapshot.revision < old.snapshot.revision) return "stale";
  if (old && snapshot.revision === old.snapshot.revision) return old.accepted === accepted ? "stale" : "conflict";
  const state: CountdownState = { snapshot, accepted, attempted: old?.attempted ?? {}, activities: old?.activities ?? {}, ended: old?.ended ?? {}, invalidTokens: old?.invalidTokens ?? [], startedAt: old?.startedAt ?? {} };
  for (const a of snapshot.activities) {
    const milestone = snapshot.milestones.find(m => m.presentationID === a.presentationID) ?? state.activities[a.activityID]?.milestone;
    if (!milestone || state.ended[a.activityID] || state.invalidTokens?.includes(a.pushToken)) continue;
    const prior = state.activities[a.activityID];
    state.activities[a.activityID] = { ...a, milestone, sentRevision: prior?.pushToken === a.pushToken ? prior.sentRevision : 0, retryAt: 0, failures: 0, lastTimestamp: prior?.lastTimestamp ?? state.startedAt?.[a.presentationID] };
    if (state.attempted[a.presentationID] || Object.keys(state.attempted).length < 1024) state.attempted[a.presentationID] = milestone.targetAtMs;
  }
  // Disappeared tokens cannot represent a current card. Keep their last token only to end it.
  for (const [id, a] of Object.entries(state.activities)) {
    if (!snapshot.activities.some(candidate => candidate.activityID === id)) a.sentRevision = -1;
  }
  // Bounded retention. Targets are never selected again after their time.
  for (const [id, target] of Object.entries(state.attempted)) if (target <= now) { delete state.attempted[id]; if (state.startedAt) delete state.startedAt[id]; }
  for (const [id, at] of Object.entries(state.ended)) if (at + 86_400_000 < now) delete state.ended[id];
  // Admission bounds include old tokens retained for cancellation. Prefer missing information
  // over unbounded state when an installation repeatedly replaces a snapshot.
  for (const id of Object.keys(state.activities).slice(32)) delete state.activities[id];
  const ended = Object.entries(state.ended).sort((a,b) => b[1] - a[1]).slice(0,256);
  state.ended = Object.fromEntries(ended);
  return state;
}
export function countdownWork(state: CountdownState, now: number, enabled: boolean): CountdownWork | undefined {
  const selected = enabled ? selectedMilestone(state.snapshot, now) : undefined;
  const activities = Object.values(state.activities).sort((a,b) => a.activityID.localeCompare(b.activityID));
  const keeper = activities.find(a => a.presentationID === selected?.presentationID && a.sentRevision !== -1)?.activityID;
  for (const a of activities) {
    if (a.retryAt > now) continue;
    if (!selected || a.presentationID !== selected.presentationID || a.sentRevision === -1 || a.activityID !== keeper || state.snapshot.dismissedPresentationIDs.includes(a.presentationID)) {
      return { event: "end", token: a.pushToken, milestone: a.milestone, activityID: a.activityID, revision: state.snapshot.revision };
    }
    if (a.sentRevision < state.snapshot.revision) return { event: "update", token: a.pushToken, milestone: selected, activityID: a.activityID, revision: state.snapshot.revision };
  }
  if (selected && state.snapshot.pushToStartToken && !state.attempted[selected.presentationID] && Object.keys(state.attempted).length < 1024) {
    // Finish previous cards before starting another. Failed ends retry within a bounded window.
    if (Object.values(state.activities).some(a => a.presentationID !== selected.presentationID)) return;
    return { event: "start", token: state.snapshot.pushToStartToken, milestone: selected, revision: state.snapshot.revision };
  }
}
export function countdownWake(state: CountdownState, now: number, enabled: boolean): number | null {
  if (countdownWork(state, now, enabled)) return now;
  const boundaries: number[] = [];
  if (enabled) for (const m of state.snapshot.milestones) {
    if (state.snapshot.dismissedPresentationIDs.includes(m.presentationID)) continue;
    if (m.targetAtMs > now) boundaries.push(m.targetAtMs);
    if (m.targetAtMs - COUNTDOWN_WINDOW_MS > now) boundaries.push(m.targetAtMs - COUNTDOWN_WINDOW_MS);
  }
  for (const a of Object.values(state.activities)) if (a.retryAt > now) boundaries.push(a.retryAt);
  return boundaries.length ? Math.min(...boundaries) : null;
}
export function countdownPayload(work: CountdownWork, at: number): string {
  const m = work.milestone;
  return JSON.stringify({ aps: { timestamp: Math.floor(at / 1000), event: work.event,
    "content-state": { kind: m.kind, targetAtMs: m.targetAtMs, revision: work.revision },
    ...(work.event === "start" ? { "attributes-type": "MeetingCountdownAttributes", attributes: { presentationID: m.presentationID }, "input-push-token": 1,
      alert: { title: "Always On Time", body: m.kind === "departure" ? "Your departure countdown is ready." : "Your event countdown is ready." } } : {}),
    ...(work.event === "end" ? { "dismissal-date": 0 } : { "stale-date": Math.floor(m.targetAtMs / 1000) }) } });
}
