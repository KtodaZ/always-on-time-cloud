"use strict";

const net = require("node:net");

function getHeader(req, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === target);
  const value = entry?.[1];
  return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : "";
}

function expandIpv6(address) {
  const [head, tail = ""] = address.split("%")[0].split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = address.includes("::") ? (tail ? tail.split(":") : []) : [];
  if (headParts.some((part) => part.includes(".")) || tailParts.some((part) => part.includes("."))) return null;
  const fill = address.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  return parts.length === 8 ? parts.map((part) => part.toLowerCase().padStart(4, "0")) : null;
}

/**
 * Rate-limit key for the caller's network. Google's front end appends the address it saw to
 * X-Forwarded-For, so the last entry is the one a client cannot forge. IPv6 clients are grouped
 * by /64 because a single subscriber usually controls a whole /64.
 */
function clientNetworkKey(req) {
  const forwarded = getHeader(req, "x-forwarded-for").split(",").map((part) => part.trim()).filter(Boolean);
  let address = forwarded.at(-1) ?? req.ip ?? req.socket?.remoteAddress ?? "unknown";
  if (address.startsWith("::ffff:") && net.isIPv4(address.slice(7))) address = address.slice(7);
  if (net.isIPv6(address)) {
    const expanded = expandIpv6(address);
    return expanded ? `v6:${expanded.slice(0, 4).join(":")}` : `v6:${address}`;
  }
  return `v4:${address}`;
}

module.exports = { clientNetworkKey };
