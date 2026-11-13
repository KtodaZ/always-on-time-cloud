import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCountdownPush } from "../src/apns";
import { countdownPayload, selectedMilestone, validateCountdown, type CountdownSnapshot } from "../src/countdown";
import { harness, MINUTE, START, type Harness } from "./helpers";

const created: Harness[] = [];
afterEach(async () => {
  // The shard pool is shared across files. Leave no due work for another harness's fetch mock.
  for (const h of created.splice(0)) {
    await h.sql(await h.shard(), "DELETE FROM countdown_state WHERE install_id = ?", h.installId);
    await h.api("DELETE", `/v2/installations/${h.installId}`);
  }
  vi.useRealTimers(); vi.restoreAllMocks();
});
const departure = "1".repeat(64), start = "2".repeat(64), startToken = "cd".repeat(32), updateToken = "ef".repeat(32);
function snapshot(h: Harness, extra: Partial<CountdownSnapshot> = {}): CountdownSnapshot {
  return { version: 1, revision: 1, pushToStartToken: startToken,
    milestones: [{ presentationID: start, kind: "start", targetAtMs: h.now() + 20 * MINUTE }],
    activities: [], dismissedPresentationIDs: [], ...extra };
}
function put(h: Harness, body: unknown, auth?: string | null) {
  return h.api("PUT", `/v2/installations/${h.installId}/countdown`, { body, ...(auth !== undefined ? { auth } : {}) });
}
async function setup() { const h = await harness(); created.push(h); expect((await h.register()).status).toBe(201); return h; }
const live = (h: Harness) => h.allApns.filter(c => c.headers["apns-push-type"] === "liveactivity");
async function tick(h: Harness, at: number) { h.setNow(at); await h.tick(); }

describe("countdown strict API", () => {
  it("uses install auth, strict fields and body bounds without changing legacy routes", async () => {
    const h = await setup(); const s = snapshot(h);
    expect((await put(h, s, null)).status).toBe(401);
    expect((await put(h, { ...s, title: "private" })).status).toBe(400);
    expect((await put(h, { ...s, pushToStartToken: undefined })).status).toBe(400);
    expect((await put(h, { ...s, pushToStartToken: "not-a-token" })).status).toBe(400);
    expect((await put(h, { ...s, milestones: [...s.milestones, ...s.milestones] })).status).toBe(400);
    expect((await put(h, { ...s, revision: 1.5 })).status).toBe(400);
    expect((await put(h, { ...s, milestones: [{ ...s.milestones[0], targetAtMs: h.now() + 91 * 24 * 60 * MINUTE }] })).status).toBe(400);
    expect((await put(h, { ...s, activities: Array.from({length: 17}, (_,i) => ({activityID: String(i), presentationID: start, pushToken: updateToken})) })).status).toBe(400);
    expect((await put(h, { ...s, extra: "x".repeat(33000) })).status).toBe(413);
    expect((await h.putAlarms([])).status).toBe(204);
    expect((await put(h, s)).status).toBe(204);
  });
  it("is idempotent, ignores stale snapshots and rejects equal conflicting revisions", async () => {
    const h = await setup(); const s = snapshot(h, { revision: 10 });
    expect((await put(h, s)).status).toBe(204);
    expect((await put(h, s)).status).toBe(204);
    expect((await put(h, {...s, revision: 9, milestones: []})).status).toBe(204);
    expect((await put(h, {...s, milestones: []})).status).toBe(409);
    await tick(h, s.milestones[0].targetAtMs - 10 * MINUTE);
    expect(live(h).map(c => c.body.aps.event)).toEqual(["start"]);
  });
});

describe("countdown windows and APNs lifecycle", () => {
  it("starts once in the ten-minute window, never replays without a token, and uses ActivityKit headers", async () => {
    const h = await setup(); const s = snapshot(h); await put(h, s);
    await tick(h, START + 9 * MINUTE); expect(live(h)).toHaveLength(0);
    await tick(h, START + 10 * MINUTE); expect(live(h)).toHaveLength(1);
    const c = live(h)[0];
    expect(c.headers["apns-topic"]).toBe("com.zombitstudios.alwaysontime.push-type.liveactivity");
    expect(c.headers["apns-priority"]).toBe("5"); expect(c.headers["apns-collapse-id"]).toBeUndefined();
    expect(c.headers["apns-expiration"]).toBe(String((START + 20 * MINUTE) / 1000));
    expect(c.body.aps).toMatchObject({event: "start", "attributes-type": "MeetingCountdownAttributes", attributes: { presentationID: start }, "input-push-token": 1});
    expect(JSON.stringify(c.body)).not.toMatch(/sound|title.*Design|location|url/i);
    await tick(h, START + 11 * MINUTE); await put(h, {...s, revision: 2}); await h.tick();
    expect(live(h)).toHaveLength(1);
  });
  it("ends at the target and chooses the next milestone during overlaps", async () => {
    const h = await setup(); const s = snapshot(h, { milestones: [
      { presentationID: departure, kind: "departure", targetAtMs: START + 15 * MINUTE },
      { presentationID: start, kind: "start", targetAtMs: START + 20 * MINUTE },
    ] }); await put(h, s);
    await tick(h, START + 5 * MINUTE);
    expect(live(h)[0].body.aps.attributes).toEqual({presentationID: departure});
    const activities = [{activityID: "a", presentationID: departure, pushToken: updateToken}];
    await put(h, {...s, revision: 2, activities}); await h.tick();
    await tick(h, START + 15 * MINUTE); await h.tick();
    expect(live(h).map(c => c.body.aps.event)).toEqual(["start", "update", "end", "start"]);
    const end = live(h)[2]; expect(end.body.aps["dismissal-date"]).toBe(0);
    expect(live(h)[3].body.aps.attributes).toEqual({presentationID: start});
    await tick(h, START + 20 * MINUTE); expect(live(h)).toHaveLength(4);
  });
  it("does not start an already expired window or a dismissed presentation", async () => {
    const h = await setup(); const s = snapshot(h); await put(h, {...s, dismissedPresentationIDs: [start]});
    await tick(h, START + 10 * MINUTE); expect(live(h)).toHaveLength(0);
    await tick(h, START + 21 * MINUTE); await put(h, {...s, revision: 2}); await h.tick();
    expect(live(h)).toHaveLength(0);
  });
  it("ends removed milestones, revokes queued starts and retains original final state", async () => {
    const h = await setup(); const s = snapshot(h); await put(h, s); await tick(h, START + 10 * MINUTE);
    await put(h, {...s, revision: 2, activities: [{activityID: "a", presentationID: start, pushToken: updateToken}]}); await h.tick();
    await put(h, {...s, revision: 3, milestones: [], activities: [], pushToStartToken: null}); await h.tick();
    expect(live(h).at(-1)?.body.aps).toMatchObject({event: "end", "content-state": {kind: "start", targetAtMs: START + 20 * MINUTE, revision: 3}});
    await tick(h, START + 20 * MINUTE); expect(live(h).filter(c => c.body.aps.event === "start")).toHaveLength(1);
  });
  it("ends a remotely started card when its first update token arrives after cancellation", async () => {
    const h = await setup(); const s = snapshot(h); await put(h,s); await tick(h,START+10*MINUTE);
    await put(h,{...s,revision:2,milestones:[],pushToStartToken:null});
    await tick(h,START+21*MINUTE);
    await put(h,{...s,revision:3,milestones:[],pushToStartToken:null,activities:[{activityID:"late",presentationID:start,pushToken:updateToken}]});
    await h.tick();
    expect(live(h).map(c=>c.body.aps.event)).toEqual(["start","end"]);
    expect(live(h)[1].body.aps["content-state"]).toMatchObject({kind:"start",targetAtMs:START+20*MINUTE});
  });
  it("token rotation replaces the old update token and rejected ActivityKit tokens do not disable alarms", async () => {
    const h = await setup(); const s = snapshot(h); const a = {activityID: "a", presentationID: start, pushToken: updateToken};
    await put(h, {...s, activities: [a]}); await tick(h, START + 10 * MINUTE);
    const rotated = "cc".repeat(32); h.respondActivity = () => ({status: 410, reason: "Unregistered"});
    await put(h, {...s, revision: 2, activities: [{...a, pushToken: rotated}]}); await h.tick();
    expect(live(h).at(-1)?.url.endsWith(rotated)).toBe(true);
    expect((await h.row())?.enabled).toBe(1);
    await put(h, {...s, revision: 3, activities: [{...a, pushToken: rotated}]}); await h.tick();
    expect(live(h)).toHaveLength(2);
    h.respondActivity = () => ({status:200});
    await put(h, {...s, revision: 4, activities: [{...a, pushToken: "dd".repeat(32)}]}); await h.tick();
    expect(live(h)).toHaveLength(3);
  });
  it("does not replay a start after ambiguous network failure or probe another APNs environment", async () => {
    const h = await setup(); h.respondActivity = () => new Error("network"); const s = snapshot(h);
    await put(h,s); await tick(h, START + 10 * MINUTE); await put(h,{...s,revision:2}); await h.tick();
    expect(live(h)).toHaveLength(1); expect((await h.row())?.enabled).toBe(1);
  });
  it("delete revokes future work and clears all stored tokens", async () => {
    const h = await setup(); await put(h,snapshot(h));
    expect((await h.api("DELETE", `/v2/installations/${h.installId}`)).status).toBe(204);
    expect(await h.sql(await h.shard(), "SELECT * FROM countdown_state WHERE install_id = ?",h.installId)).toEqual([]);
    await tick(h, START + 10 * MINUTE); expect(live(h)).toHaveLength(0);
  });
  it("a cancelled snapshot during token acquisition cannot send an obsolete start", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"); let current = true;
    const result = await sendCountdownPush({topic: "com.example.app", keyPem: "unused", keyId: "unused", teamId: "unused"},
      { get: async () => { current = false; return "test-provider-token"; }, rejected: async () => {} },
      { environment: "development", token: startToken, body: "{}", expiresAt: 0 }, () => current);
    expect(result).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("BadDeviceToken invalidates only the start token and is not probed or replayed", async () => {
    const h = await setup(); const s = snapshot(h); h.respondActivity = () => ({status:400,reason:"BadDeviceToken"});
    await put(h,s); await tick(h,START+10*MINUTE); await put(h,s); await h.tick();
    expect(live(h)).toHaveLength(1); expect((await h.row())?.enabled).toBe(1);
  });
  it("a normal device-token rejection cancels future countdown starts", async () => {
    const h = await setup(); const s = snapshot(h,{milestones:[{presentationID:start,kind:"start",targetAtMs:START+30*MINUTE}]});
    await put(h,s); await h.putAlarms([{id:"alarm",triggerAtMs:START+10*MINUTE}]);
    h.respond = () => ({status:410,reason:"Unregistered"});
    await tick(h,START+2*MINUTE); expect((await h.row())?.enabled).toBe(0);
    await tick(h,START+20*MINUTE); expect(live(h)).toHaveLength(0);
  });
  it("ends duplicate local/remote cards and sends strictly ordered activity timestamps", async () => {
    const h = await setup(); const s = snapshot(h,{activities:[
      {activityID:"a",presentationID:start,pushToken:updateToken},
      {activityID:"b",presentationID:start,pushToken:"cc".repeat(32)}]});
    await put(h,s); await tick(h,START+10*MINUTE); await h.tick();
    expect(live(h).map(c=>c.body.aps.event)).toEqual(["update","end"]);
    await put(h,{...s,revision:2,milestones:[],activities:[]}); await h.tick();
    const a = live(h).filter(c=>c.url.endsWith(updateToken));
    expect(a.map(c=>c.body.aps.event)).toEqual(["update","end"]);
    expect(a[1].body.aps.timestamp).toBeGreaterThan(a[0].body.aps.timestamp as number);
  });
});

it("payloads use seconds for APNs and milliseconds in content state", () => {
  const body = JSON.parse(countdownPayload({ event: "end", token: updateToken, revision: 2,
    milestone: {presentationID: start,kind:"start",targetAtMs:START+10*MINUTE} }, START));
  expect(body.aps.timestamp).toBe(START/1000);
  expect(body.aps["content-state"].targetAtMs).toBe(START+10*MINUTE);
  expect(body.aps["dismissal-date"]).toBe(0);
  expect(() => validateCountdown({version: 1},START)).toThrow();
});
