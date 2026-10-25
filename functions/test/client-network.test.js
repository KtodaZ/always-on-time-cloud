"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { clientNetworkKey } = require("../client-network");

test("rate-limit keys use the proxy-appended client address and group IPv6 by /64", () => {
  assert.equal(clientNetworkKey({ headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } }), "v4:198.51.100.7");
  assert.equal(clientNetworkKey({ headers: { "x-forwarded-for": "2001:db8:1:2:aaaa::1" } }), "v6:2001:0db8:0001:0002");
  assert.equal(clientNetworkKey({ headers: { "x-forwarded-for": "2001:db8:1:2:bbbb::9" } }), "v6:2001:0db8:0001:0002");
  assert.equal(clientNetworkKey({ headers: {}, ip: "::ffff:192.0.2.1" }), "v4:192.0.2.1");
});
