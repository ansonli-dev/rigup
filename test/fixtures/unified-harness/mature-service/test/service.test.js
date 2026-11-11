const { test } = require("node:test");
const { strictEqual } = require("node:assert");
const { invalidOrder } = require("../src/service.js");
test("rejects invalid orders", () => strictEqual(invalidOrder().status, 422));
