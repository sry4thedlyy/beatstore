import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePrice } from "../src/domain/pricing";
import { parseRange } from "../src/server/media";

test("discount uses exact decimal rounding and excludes exclusive", () => {
  assert.equal(calculatePrice(200000, "10.00", "WAV"), 180000);
  assert.equal(calculatePrice(300000, "0.00", "STEMS"), 300000);
  assert.equal(calculatePrice(101, "50.00", "MP3"), 51);
  assert.equal(calculatePrice(1000, "33.33", "DRUMKIT"), 667);
  assert.equal(calculatePrice(1500000, "10.00", "EXCLUSIVE"), 1500000);
  for (const discount of ["-1", "101", "10.001", "NaN", "1e2", "100"]) {
    assert.throws(() => calculatePrice(100000, discount, "WAV"));
  }
});

test("audio ranges support browser seeking, open and suffix ranges", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=80-", 100), { start: 80, end: 99 });
  assert.deepEqual(parseRange("bytes=-20", 100), { start: 80, end: 99 });
  assert.deepEqual(parseRange("bytes=80-500", 100), { start: 80, end: 99 });
  for (const range of [
    "bytes=100-",
    "bytes=20-10",
    "bytes=-0",
    "bytes=-",
    "bytes=0-5,10-20",
    "bytes=999999999999999999999-",
  ])
    assert.equal(parseRange(range, 100), null);
});
