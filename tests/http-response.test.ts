import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson, requestFailure } from "../src/components/read-json";

test("empty, truncated, HTML and invalid JSON responses show a recovery message", async () => {
  const fallback = "Заказ сохранён; проверь состояние в кабинете.";
  for (const body of [
    "",
    '{"status":',
    "<html>Proxy failure</html>",
    "null",
    "[]",
  ]) {
    await assert.rejects(
      readJson(new Response(body), fallback),
      (error: unknown) => {
        assert.equal(requestFailure(error, "Other"), fallback);
        return true;
      },
    );
  }
  assert.equal(
    requestFailure(new TypeError("Failed to fetch"), fallback),
    fallback,
  );
});

test("valid responses and shop validation messages remain available", async () => {
  assert.deepEqual(
    await readJson(Response.json({ status: "PAID" }), "Fallback"),
    { status: "PAID" },
  );
  const message = "Карточка уже изменилась. Обнови страницу перед сохранением.";
  await assert.rejects(
    readJson(Response.json({ message }, { status: 409 }), "Fallback"),
    (error: unknown) => {
      assert.equal(requestFailure(error, "Other"), message);
      return true;
    },
  );
  await assert.rejects(
    readJson(Response.json({ message: 5 }, { status: 503 }), "Fallback"),
    /Fallback/,
  );
});
