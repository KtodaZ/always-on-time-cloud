"use strict";

// Server-side scrub of the optional diagnostics file attached to feedback from the Android and iOS apps.
//
// The apps redact the file before upload (DeviceLogSanitizer on Android, DiagnosticsScrubber on iOS, in the
// app repository). This pass
// repeats the same rules on the stored object so files from app versions with weaker rules, or a
// value no client rule anticipated, do not stay in Storage. It keeps alarm IDs, epoch millis,
// lead times, time zones and stack traces readable, and leaves the app's own tags
// (`<email:h=…>`, `<title:len=…>`) untouched, so scrubbing twice changes nothing.

const SCRUB_METADATA_KEY = "aotScrubbed";
const SCRUB_VERSION = "1";
const MAX_SCRUB_BYTES = 5 * 1024 * 1024;
const FEEDBACK_OBJECT = /^feedback\/[^/]+\/[^/]+\/[^/]+$/;

const MEETING_HOSTS = {
  "meet.google.com": "meet",
  "zoom.us": "zoom",
  "zoom.com": "zoom",
  "zoomgov.com": "zoom",
  "teams.microsoft.com": "teams",
  "teams.live.com": "teams",
  "webex.com": "webex",
  "gotomeeting.com": "goto",
  "gotomeet.me": "goto",
  "meet.goto.com": "goto",
  "bluejeans.com": "bluejeans",
  "whereby.com": "whereby",
  "chime.aws": "chime",
  "meet.jit.si": "jitsi",
  "join.skype.com": "skype",
  "facetime.apple.com": "facetime",
};
const MEETING_SCHEMES = {
  zoommtg: "zoom", zoomus: "zoom", msteams: "teams", webex: "webex", ciscowebex: "webex",
  facetime: "facetime", "facetime-audio": "facetime", skype: "skype",
};
const SERVICE_HOSTS = [
  "googleapis.com", "firebaseio.com", "firebasestorage.app", "cloudfunctions.net", "zombit.io", "tomtom.com",
  "gstatic.com", "google.com", "android.com",
];
const PHONE_SCHEMES = new Set(["tel", "sms", "smsto", "sip", "sips"]);
const LOCATION_SCHEMES = new Set(["geo", "google.navigation", "comgooglemaps", "waze", "maps"]);
const SAFE_CONTENT_AUTHORITIES = new Set([
  "com.android.calendar", "media", "settings", "com.zombitstudios.alwaysontime.provider",
]);
const TRAILING_PUNCTUATION = ".,;:!?)]}>'\"";

const escapeHost = (host) => host.replace(/\./g, "\\.");
const PHONE_BOUNDARY_BEFORE = "(?<![\\w+=#/.:<-])";

const patterns = {
  bearer: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  secrets: [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\bya29\.[0-9A-Za-z._-]+/g,
    /\b[A-Za-z0-9_-]{11,}:APA91[A-Za-z0-9_-]{20,}/g,
  ],
  secretField: /\b(access_token|refresh_token|id_token|token|api[_-]?key|client_secret|secret|password|passwd|authorization)(\s*[=:]\s*)(?!<)(?!bearer\s)[^\s,;&)}\]"']{6,}/gi,
  intentData: /\bdat=(?!<)(.+?)(?=\s(?:typ|flg|xflg|pkg|cmp|bnds|sel|clip|launchParam)=|\s\(has |\s?}|$)/gm,
  locationLink: /(?<![\w.+-])(?:geo|google\.navigation|comgooglemaps|waze|maps):[^\s"'<>]*(?:[ \t]+(?![\w.-]*=)[^\s"'<>{}]+)*/gi,
  schemeUrl: /(?<![\w.+-])(?:https?|ftp|wss?|content|file|mailto|tel|sms|smsto|sip|sips|intent|zoommtg|zoomus|msteams|webex|ciscowebex|facetime|facetime-audio|skype|market):[^\s"'<>]+/gi,
  encodedEmail: /(?<![\w.%+-])[A-Z0-9._+-]+%40[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}\b/gi,
  email: /(?<![\w.%+-])[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}\b/gi,
  meetingHost: new RegExp(
    `(?<![\\w.@/-])(?:[a-z0-9-]+\\.)*(?:${Object.keys(MEETING_HOSTS).map(escapeHost).join("|")})(?![\\w.-])(?:[/?#][^\\s"'<>]*)?`,
    "gi",
  ),
  hostPath: /(?<![\w.@/-])(?:www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|us|co|me|ly|gl|app|dev|ai|edu|gov|uk|de|ca|au|fr|in|jp|nl|es|it|info|biz|link|page|to|gg|vc|tv|cc|so)(?=[/?#]))[^\s"'<>]*/gi,
  dialIn: /\b(pin|passcode|access code|meeting id|conference id|participant code)\b(\s*[:#=]?\s*)\d[\d #-]{3,}\d#?/gi,
  internationalPhone: new RegExp(`${PHONE_BOUNDARY_BEFORE}\\+\\d{1,3}(?:[ .-]?\\(?\\d{1,4}\\)?){2,6}(?![\\w-])`, "g"),
  northAmericanPhone: new RegExp(`${PHONE_BOUNDARY_BEFORE}(?:\\(\\d{3}\\) ?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}(?![\\w-])`, "g"),
  trunkPhone: new RegExp(`${PHONE_BOUNDARY_BEFORE}0\\d{1,4}(?:[ .-]\\d{2,4}){2,4}(?![\\w-])`, "g"),
  coordinatePair: /(?<![\w.])(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?!\d)/g,
  coordinateKey: /(?<!<)\b(lat|lng|lon|latitude|longitude)(\s*[=:]\s*)(?!<)-?\d{1,3}(?:\.\d+)?/gi,
  streetAddress: new RegExp(
    "\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Z0-9][\\w.'-]*\\s+){1,4}" +
      "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|" +
      "Parkway|Pkwy|Highway|Hwy|Terrace|Circle|Cir|Square|Sq|Plaza)\\b\\.?" +
      "(?:\\s*(?:#|Apt\\.?|Suite|Ste\\.?|Unit)\\s*\\w+)?" +
      "(?:,[ \\t]*[A-Z][\\w.'-]*(?:[ \\t]+[A-Z][\\w.'-]*)*){0,3}" +
      "(?:[ \\t]+\\d{5}(?:-\\d{4})?)?",
    "g",
  ),
  personalField: new RegExp(
    "(?<!<)\\b(title|eventTitle|summary|calendarName|calendarDisplayName|displayName|accountName|accountEmail|" +
      "ownerAccount|organizer|attendees?|location|eventLocation|address|description|notes?|ssid|bssid|" +
      "wifiName|bluetoothName|phoneNumber|contactName|placeName|userName|username)" +
      "(\\s*=\\s*|\\s*:\\s*)(?!<)" +
      "(\"[^\"\\n]*\"|'[^'\\n]*'|“[^”\\n]*”|(?<==\\s{0,3})[^\\s,;)}\\]]+|[^,;|\\n]+?(?=\\s*[,;|]|\\s+\\w+=|$))",
    "gim",
  ),
  curlyQuoted: /“(?!<)([^”\n]{1,300})”/g,
};

function trailingOf(value) {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(value[end - 1])) end -= 1;
  return value.slice(end);
}

function withTrailing(value, replace) {
  const trailing = trailingOf(value);
  return replace(value.slice(0, value.length - trailing.length)) + trailing;
}

function hostOf(link) {
  const afterScheme = link.includes("://") ? link.slice(link.indexOf("://") + 3) : link;
  const authority = afterScheme.split(/[/?#]/)[0];
  return authority.slice(authority.lastIndexOf("@") + 1).split(":")[0].toLowerCase();
}

function meetingTag(link) {
  const lower = link.toLowerCase();
  const scheme = lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : "";
  if (MEETING_SCHEMES[scheme]) return `<meeting-url:${MEETING_SCHEMES[scheme]}>`;
  const host = hostOf(lower);
  const match = Object.entries(MEETING_HOSTS).find(([known]) => host === known || host.endsWith(`.${known}`));
  return match ? `<meeting-url:${match[1]}>` : null;
}

function schemeUrlTag(link) {
  const scheme = link.slice(0, Math.max(link.indexOf(":"), 0)).toLowerCase();
  if (scheme === "content") {
    const authorityAndPath = link.includes("://") ? link.slice(link.indexOf("://") + 3) : "";
    const authority = authorityAndPath.split("/")[0];
    if (SAFE_CONTENT_AUTHORITIES.has(authority) && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)*$/.test(authorityAndPath)) {
      return link;
    }
  }
  if (PHONE_SCHEMES.has(scheme)) return "<redacted-phone>";
  if (scheme === "mailto") return "<redacted-url>";
  if (LOCATION_SCHEMES.has(scheme)) return "<redacted-location-url>";
  const meeting = meetingTag(link);
  if (meeting) return meeting;
  const host = hostOf(link);
  if (SERVICE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) return `<url:${host}>`;
  return "<redacted-url>";
}

const digitCount = (value) => (value.match(/\d/g) || []).length;

/** Removes personal data from diagnostics text; see the file comment. */
function scrubDiagnosticText(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let text = value;
  text = text.replace(patterns.bearer, (_, word) => `${word} <redacted-secret>`);
  for (const pattern of patterns.secrets) text = text.replace(pattern, "<redacted-secret>");
  text = text.replace(patterns.secretField, (_, key, separator) => `${key}${separator}<redacted-secret>`);
  text = text.replace(patterns.intentData, (_, data) => `dat=${schemeUrlTag(data)}`);
  text = text.replace(patterns.locationLink, (match) => withTrailing(match, () => "<redacted-location-url>"));
  text = text.replace(patterns.schemeUrl, (match) => withTrailing(match, schemeUrlTag));
  text = text.replace(patterns.encodedEmail, "<redacted-email>");
  text = text.replace(patterns.email, "<redacted-email>");
  text = text.replace(patterns.meetingHost, (match) => withTrailing(match, (link) => meetingTag(link) || "<redacted-url>"));
  text = text.replace(patterns.hostPath, (match) => withTrailing(match, () => "<redacted-url>"));
  text = text.replace(patterns.dialIn, (_, key, separator) => `${key}${separator}<redacted-number>`);
  text = text.replace(patterns.internationalPhone, (match) => {
    const digits = digitCount(match);
    return digits >= 8 && digits <= 15 ? "<redacted-phone>" : match;
  });
  text = text.replace(patterns.northAmericanPhone, "<redacted-phone>");
  text = text.replace(patterns.trunkPhone, (match) => {
    const digits = digitCount(match);
    return digits >= 9 && digits <= 13 ? "<redacted-phone>" : match;
  });
  text = text.replace(patterns.coordinatePair, (match, lat, lng) => (
    Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 ? "<redacted-coords>" : match
  ));
  text = text.replace(patterns.coordinateKey, (_, key, separator) => `${key}${separator}<redacted>`);
  text = text.replace(patterns.streetAddress, "<redacted-address>");
  text = text.replace(patterns.personalField, (_, key, separator, raw) => {
    const unquoted = raw.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").replace(/^“(.*)”$/s, "$1");
    return `${key}${separator}<${key}:len=${unquoted.trim().length}>`;
  });
  text = text.replace(patterns.curlyQuoted, (_, quoted) => `“<text:len=${quoted.trim().length}>”`);
  return text;
}

/** Scrubs a whole diagnostics file line by line, so no rule can join two lines. */
function scrubDiagnosticLog(contents) {
  return contents.split("\n").map(scrubDiagnosticText).join("\n");
}

/** Whether a finalized Storage object is a feedback diagnostics file this pass has not handled. */
function needsScrub(object) {
  if (!object || typeof object.name !== "string" || !FEEDBACK_OBJECT.test(object.name)) return false;
  if (!String(object.contentType || "").toLowerCase().startsWith("text/plain")) return false;
  if (object.metadata && object.metadata[SCRUB_METADATA_KEY] === SCRUB_VERSION) return false;
  const size = Number(object.size || 0);
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_SCRUB_BYTES;
}

/**
 * Rewrites the object with personal data removed and marks it scrubbed. The rewrite finalizes a
 * new generation, which this pass then skips by its marker. The generation precondition leaves a
 * file alone if it changed while it was being read.
 */
async function scrubFeedbackDiagnosticObject(object, bucket, logger) {
  if (!needsScrub(object)) return { status: "skipped" };
  const file = bucket.file(object.name);
  const [buffer] = await file.download();
  const original = buffer.toString("utf8");
  const scrubbed = scrubDiagnosticLog(original);
  const metadata = { ...(object.metadata || {}), [SCRUB_METADATA_KEY]: SCRUB_VERSION };
  if (scrubbed === original) {
    await file.setMetadata({ metadata }, { ifGenerationMatch: object.generation });
    return { status: "clean" };
  }
  await file.save(scrubbed, {
    resumable: false,
    contentType: object.contentType || "text/plain",
    metadata: { metadata },
    preconditionOpts: { ifGenerationMatch: object.generation },
  });
  const changedLines = countChangedLines(original, scrubbed);
  logger?.info?.("Scrubbed a feedback diagnostics file", { changedLines });
  return { status: "scrubbed", changedLines };
}

function countChangedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) changed += 1;
  return changed;
}

module.exports = {
  MAX_SCRUB_BYTES,
  SCRUB_METADATA_KEY,
  SCRUB_VERSION,
  needsScrub,
  scrubDiagnosticLog,
  scrubDiagnosticText,
  scrubFeedbackDiagnosticObject,
};
