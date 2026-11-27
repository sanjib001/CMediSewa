import { test } from "node:test";
import assert from "node:assert/strict";
import { amountInWords, numberInWords } from "./money-words.ts";

test("amounts in words, Nepali grouping (lakh, crore)", () => {
  assert.equal(numberInWords(0), "Zero");
  assert.equal(numberInWords(15), "Fifteen");
  assert.equal(numberInWords(105), "One Hundred Five");
  assert.equal(numberInWords(2034), "Two Thousand Thirty Four");
  assert.equal(numberInWords(150000), "One Lakh Fifty Thousand");
  assert.equal(numberInWords(12345678), "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight");
  assert.equal(amountInWords(1205.5), "Rupees One Thousand Two Hundred Five and Fifty Paisa Only");
  assert.equal(amountInWords(2025.22), "Rupees Two Thousand Twenty Five and Twenty Two Paisa Only");
  assert.equal(amountInWords(45), "Rupees Forty Five Only");
});
