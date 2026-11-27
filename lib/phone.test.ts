import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, phoneProblem } from "./phone.ts";

test("phones typed at the counter: Nepali digits converted, clear problems named", () => {
  assert.equal(normalizePhone(" ९८४१२३४५६७ "), "9841234567");
  assert.equal(normalizePhone("01-44  12345"), "01-44 12345");
  assert.equal(phoneProblem("9841234567"), null);
  assert.equal(phoneProblem("01-4412345"), null);
  assert.equal(phoneProblem("+977 9841234567"), null);
  assert.equal(phoneProblem(""), null);
  assert.match(phoneProblem("98412")!, /too short/);
  assert.match(phoneProblem("9841234567/9851234567")!, /one phone number/);
  assert.match(phoneProblem("984.123.4567")!, /digits only/);
});
