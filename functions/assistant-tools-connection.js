"use strict";

// Connection tools: status, the setup test, refreshing and confirming against the phones, and
// App Links into the app.

const { randomBytes } = require("node:crypto");
const z = require("zod");

const {
  UNDO_DAYS, readAppliedThrough, readDevices, readSnapshotTimes, readValues, refs, toMillis,
} = require("./assistant-data");
const { canReceive, deviceName } = require("./assistant-push");
const { PAUSED_UNTIL } = require("./assistant-records");
const { describePause, parseStored } = require("./assistant-settings");
const {
  DESTINATIONS, ToolError, appLink, basedOn, basis, cleanText, formatTime, isoLocal, relativeAge, resolveCalendar, resolveEvent,
} = require("./assistant-snapshot");
const {
  deviceSnapshot, hasPlus, latestSnapshot, names, noPhone, push, result, sleepUntil, trace,
} = require("./assistant-tool-context");
const { changeIdInput } = require("./assistant-tools-write");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CAPABILITIES = ["travel", "spokenAlarms", "plus", "pause"];

/**
 * Polls how far each phone has applied the account's values. Each poll reads only the snapshots'
 * publish times; a snapshot's payload is read again only after its phone published a new one, and
 * then only its valuesAppliedThrough is extracted (never the whole payload parsed).
 */
function appliedTracker(ctx) {
  const known = new Map();
  return async () => {
    const out = [];
    for (const { deviceId, publishedAt } of await readSnapshotTimes(ctx.db, ctx.uid)) {
      let entry = known.get(deviceId);
      if (!entry || entry.publishedAt !== publishedAt) {
        entry = { publishedAt, appliedThrough: await readAppliedThrough(ctx.db, ctx.uid, deviceId) };
        known.set(deviceId, entry);
      }
      if (entry.appliedThrough !== null) out.push({ deviceId, valuesAppliedThrough: entry.appliedThrough });
    }
    return out;
  };
}

const TOOLS = [
  {
    name: "get_status",
    title: "Connection status",
    description: "Connected phones, when each last shared its alarms, whether alarms are paused, what each phone supports, and whether setup has been confirmed. Call this first in a conversation; if setup is not confirmed, call test_connection next.",
    inputSchema: {},
    annotations: READ,
    scope: "read",
    async handler(ctx) {
      // Only the newest snapshot is read in full; the others' publish times are enough here.
      const [devices, times, latest, values] = await Promise.all([
        readDevices(ctx.db, ctx.uid), readSnapshotTimes(ctx.db, ctx.uid), latestSnapshot(ctx), readValues(ctx.db, ctx.uid, [`p_${PAUSED_UNTIL}`]),
      ]);
      const now = ctx.now();
      const timeZone = latest?.timeZone ?? "UTC";
      const ids = new Set([...devices.map((device) => device.id), ...times.map((item) => item.deviceId)]);
      const phones = [...ids].map((id) => {
        const device = devices.find((item) => item.id === id) ?? { id };
        const isLatest = latest?.deviceId === id;
        const shared = isLatest ? latest.builtAt : times.find((item) => item.deviceId === id)?.publishedAt ?? null;
        return {
          deviceId: id,
          name: cleanText(device.deviceName, 100) || (isLatest ? latest.device : null) || "phone",
          platform: device.platform === "android" || device.platform === "ios" ? device.platform : null,
          appVersion: cleanText(device.appVersion, 40) || null,
          capabilities: Array.isArray(device.capabilities) ? device.capabilities.filter((item) => CAPABILITIES.includes(item)) : [],
          canReceiveMessages: canReceive(device),
          lastSharedAt: shared ? isoLocal(shared, timeZone) : null,
          lastSharedMillis: shared,
        };
      });
      const setupConfirmed = Boolean(ctx.grant.setupConfirmedAt);
      const pausedRecord = parseStored(values[`p_${PAUSED_UNTIL}`]);
      const pausedUntil = latest ? latest.paused.until : Number.isSafeInteger(pausedRecord) ? pausedRecord : 0;
      const lines = [`Connected as ${ctx.grant.clientName}.`];
      if (!phones.length) {
        const link = appLink(ctx.origin, "assistants");
        lines.push(`No phone has finished connecting. Ask the user to open Always On Time on their phone, signed in with the same Google account. Link: ${link}`);
        return result(lines.join("\n"), { setupConfirmed, phones, links: { assistants: link } });
      }
      lines.push(setupConfirmed
        ? `Setup confirmed ${formatTime(ctx.grant.setupConfirmedAt, timeZone)}.`
        : "Setup is not confirmed yet: call test_connection now and tell the user the result.");
      for (const phone of phones) {
        const shared = phone.lastSharedMillis ? `last shared alarms ${relativeAge(phone.lastSharedMillis, now)}` : "hasn't shared alarms yet";
        const parts = [phone.platform === "ios" ? "iPhone" : phone.platform === "android" ? "Android" : null, phone.appVersion ? `app ${phone.appVersion}` : null,
          phone.canReceiveMessages ? "can receive changes instantly" : "gets changes on its next sync", shared].filter(Boolean);
        lines.push(`Phone: ${phone.name} (${parts.join("; ")}).`);
      }
      lines.push(`Alarms are ${describePause(pausedUntil, timeZone)}.`);
      if (latest) lines.push(basis(latest, now));
      return result(lines.join("\n"), {
        setupConfirmed,
        phones,
        alarms: { paused: pausedUntil !== 0, pausedUntil: pausedUntil > 0 ? isoLocal(pausedUntil, timeZone) : pausedUntil === -1 ? "until resumed" : null },
        timeZone,
        plus: hasPlus(devices),
      });
    },
  },
  {
    name: "confirm_change",
    title: "Confirm a change reached the phone",
    description: "Waits up to waitSeconds for the user's phones to apply a change, then reports which did. Call it after every change before telling the user the alarm is set on their phone.",
    inputSchema: {
      changeId: changeIdInput("The changeId a change returned."),
      waitSeconds: z.number().int().min(0).max(15).optional().describe("How long to wait (default 10, at most 15)."),
    },
    annotations: READ,
    scope: "read",
    waits: true,
    async handler(ctx, args) {
      trace(ctx, { changeId: args.changeId });
      const activity = await refs.activity(ctx.db, ctx.uid).doc(args.changeId).get();
      if (!activity.exists) throw new ToolError(`No change with that changeId in the last ${UNDO_DAYS} days.`);
      // Written in the same commit as the values, so it is their updatedAt, which phones report back.
      const writtenAt = toMillis(activity.data().writtenAt);
      if (writtenAt === null) throw new Error("activity entry without writtenAt");
      const deadline = ctx.now() + (args.waitSeconds ?? 10) * 1000;
      const phones = await readDevices(ctx.db, ctx.uid);
      const poll = appliedTracker(ctx);
      let snapshots = [];
      await sleepUntil(ctx, deadline, async () => {
        snapshots = await poll();
        return snapshots.length > 0 && snapshots.every((snapshot) => snapshot.valuesAppliedThrough >= writtenAt);
      });
      const applied = snapshots.filter((snapshot) => snapshot.valuesAppliedThrough >= writtenAt);
      const waiting = snapshots.filter((snapshot) => snapshot.valuesAppliedThrough < writtenAt);
      const outcome = !snapshots.length || !applied.length ? "pending" : waiting.length ? "partial" : "confirmed";
      ctx.count(`confirms.${outcome}`);
      trace(ctx, { status: outcome });
      const label = (snapshot) => deviceName(phones.find((device) => device.id === snapshot.deviceId) ?? {});
      const devices = (list) => list.map(label).join(", ");
      let text;
      if (outcome === "confirmed") text = `Confirmed on ${devices(applied)}.`;
      else if (outcome === "partial") text = `Confirmed on ${devices(applied)}; ${devices(waiting)} will apply it when it's online.`;
      else text = "Saved; the phone will apply it when it's online (opening Always On Time syncs it right away).";
      return result(text, {
        outcome,
        appliedOn: applied.map(label),
        waitingOn: waiting.map(label),
      });
    },
  },
  {
    name: "test_connection",
    title: "Test the connection to the phone",
    description: "Setup check: sends a test message to each connected phone (it shows a \"connected\" notification) and reports which received it. Run it the first time a connection is used, when get_status says setup isn't confirmed, or when changes don't seem to reach the phone.",
    inputSchema: { waitSeconds: z.number().int().min(1).max(20).optional().describe("How long to wait for phones to answer (default 15, at most 20).") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: "read",
    waits: true,
    async handler(ctx, args) {
      const devices = await readDevices(ctx.db, ctx.uid);
      if (!devices.length) {
        ctx.count("setupTests.noDevices");
        trace(ctx, { status: "noDevices" });
        const link = appLink(ctx.origin, "assistants");
        return result(`Open Always On Time on your phone to finish connecting (signed in with the same Google account), then run this test again. Link: ${link}`, {
          outcome: "noDevices", links: { assistants: link },
        });
      }
      const pingId = `ping_${randomBytes(12).toString("base64url")}`;
      trace(ctx, { pingId });
      const sent = await push(ctx, "ping", { pingId, assistant: String(ctx.grant.clientName).slice(0, 60) }, devices);
      if (sent.limited) throw new ToolError("Too many messages to the phone recently; wait a few minutes and try again.");
      const reachable = sent.sent;
      const deadline = ctx.now() + (args.waitSeconds ?? 15) * 1000;
      let received = [];
      if (reachable.length) {
        await sleepUntil(ctx, deadline, async () => {
          const current = await readDevices(ctx.db, ctx.uid);
          received = current.filter((device) => device.lastPing?.id === pingId);
          return received.length === reachable.length;
        });
      }
      const missing = devices.filter((device) => !received.some((item) => item.id === device.id));
      const lines = [];
      if (received.length) lines.push(`Message received on ${names(received)}.`);
      const permissions = appLink(ctx.origin, "permissions");
      const battery = appLink(ctx.origin, "battery");
      const silent = missing.filter(canReceive);
      if (silent.length) lines.push(`${names(silent)} didn't answer. Ask the user to open Always On Time, and check its notification and battery settings: ${permissions} and ${battery}`);
      const noToken = missing.filter((device) => !canReceive(device));
      if (noToken.length) lines.push(`${names(noToken)} can't receive messages from the assistant yet; changes reach it on its next sync.`);
      const outcome = received.length ? (missing.length ? "partial" : "received") : silent.length ? "noAnswer" : "unreachable";
      ctx.count(`setupTests.${outcome}`);
      trace(ctx, { status: outcome });
      if (received.length && !ctx.grant.setupConfirmedAt) {
        await ctx.confirmSetup();
        lines.push("Setup is confirmed.");
      }
      return result(lines.join("\n"), {
        outcome,
        received: received.map(deviceName),
        noAnswer: silent.map(deviceName),
        cannotReceive: noToken.map(deviceName),
        links: missing.length ? { permissions, battery } : {},
      });
    },
  },
  {
    name: "refresh",
    title: "Refresh from the phone",
    description: "Asks the phones to share their alarms now and waits for a fresh copy; returns it, or the last one with its time. Use it when the snapshot looks old or right after the user changed something in the app.",
    inputSchema: { waitSeconds: z.number().int().min(1).max(15).optional().describe("How long to wait (default 10, at most 15).") },
    annotations: READ,
    scope: "read",
    waits: true,
    async handler(ctx, args) {
      const devices = await readDevices(ctx.db, ctx.uid);
      if (!devices.length) return noPhone(ctx);
      const requestId = `req_${randomBytes(12).toString("base64url")}`;
      trace(ctx, { requestId });
      const sent = await push(ctx, "publish", { requestId }, devices);
      if (sent.limited) throw new ToolError("Too many messages to the phone recently; wait a few minutes and try again.");
      const deadline = ctx.now() + (args.waitSeconds ?? 10) * 1000;
      // Polls only the publish times until the answering snapshot appears, then reads that one.
      const answered = sent.sent.length ? await sleepUntil(ctx, deadline, async () => {
        const times = await readSnapshotTimes(ctx.db, ctx.uid);
        return times.find((item) => item.requestId === requestId) ?? null;
      }) : null;
      let fresh = answered ? await deviceSnapshot(ctx, answered.deviceId) : null;
      if (fresh && fresh.requestId !== requestId) fresh = null;
      const snapshot = fresh ?? await latestSnapshot(ctx);
      if (!snapshot) return noPhone(ctx);
      trace(ctx, { status: fresh ? "fresh" : "stale" });
      const alarms = snapshot.events.reduce((total, event) => total + event.alarms.filter((alarm) => alarm.status === "on").length, 0);
      const summary = `${snapshot.events.length} events with ${alarms} upcoming alarms on ${snapshot.calendars.filter((c) => c.watched).length} watched calendars.`;
      const text = fresh
        ? `Fresh from ${snapshot.device}: ${summary}`
        : `${snapshot.device} didn't answer in time; the last copy is ${relativeAge(snapshot.builtAt, ctx.now())} old. ${basis(snapshot, ctx.now())} ${summary}`;
      return result(text, {
        fresh: Boolean(fresh),
        basedOn: basedOn(snapshot),
        events: snapshot.events.length,
        alarms,
      });
    },
  },
  {
    name: "open_in_app",
    title: "Link to a screen in the app",
    description: "Returns a link that opens a screen of Always On Time on the user's phone: an event, calendars, settings, permissions, battery guidance, travel, account, connected assistants, or Plus. Use it for anything that has to be done on the phone (sounds, voices, permissions) and when the user wants Plus. Links only open screens; they never change anything.",
    inputSchema: {
      destination: z.enum(DESTINATIONS),
      key: z.string().max(80).optional().describe("Event key for \"event\", calendar key for \"calendar\" (short forms work)."),
    },
    annotations: READ,
    scope: "read",
    async handler(ctx, args) {
      let key = args.key;
      if (args.destination === "event" || args.destination === "calendar") {
        if (!key) throw new ToolError(`${args.destination} links need a key.`);
        const snapshot = await latestSnapshot(ctx);
        key = args.destination === "event"
          ? resolveEvent(snapshot, { event: key }).eventKey
          : resolveCalendar(snapshot, key).key;
      }
      const link = appLink(ctx.origin, args.destination, key);
      let text = `Open in Always On Time: ${link}`;
      if (args.destination === "plus") {
        ctx.count("plusGate");
        text = `Live traffic updates are part of Always On Time Plus, which the user can get in the app (the assistant can't turn it on): ${link}`;
      }
      return result(text, { link });
    },
  },
];

module.exports = { TOOLS };
