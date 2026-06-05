import { test } from "node:test";
import assert from "node:assert/strict";
import { TiimoError, TiimoClient, uuidv7 } from "./client.js";

test("TiimoError carries name, status, detail", () => {
  const e = new TiimoError("bad request", 400, { title: "oops" });
  assert.equal(e.name, "TiimoError");
  assert.equal(e.message, "bad request");
  assert.equal(e.status, 400);
  assert.deepEqual(e.detail, { title: "oops" });
  assert(e instanceof Error);
  assert(e instanceof TiimoError);
});

test("TiimoError without detail is undefined", () => {
  const e = new TiimoError("fail", 0);
  assert.equal(e.status, 0);
  assert.equal(e.detail, undefined);
});

test("uuidv7 is a valid UUID v7", () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("uuidv7 generates unique ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => uuidv7()));
  assert.equal(ids.size, 200, "expected all 200 uuids to be unique");
});

test("TiimoClient constructor is lenient — no throw on empty config", () => {
  const client = new TiimoClient({ token: "", profileId: "" });
  assert.ok(client);
});

test("TiimoClient.listTaskLists throws clear error when TIIMO_TOKEN is missing", async () => {
  const client = new TiimoClient({ token: "", profileId: "some-profile" });
  await assert.rejects(
    () => client.listTaskLists(),
    (err) => {
      assert(err instanceof TiimoError, `expected TiimoError, got ${err}`);
      assert.match(err.message, /TIIMO_TOKEN is not set/);
      assert.equal(err.status, 0);
      return true;
    },
  );
});

test("TiimoClient.listTaskLists throws clear error when TIIMO_PROFILE_ID is missing", async () => {
  const client = new TiimoClient({ token: "some-token", profileId: "" });
  await assert.rejects(
    () => client.listTaskLists(),
    (err) => {
      assert(err instanceof TiimoError);
      assert.match(err.message, /TIIMO_PROFILE_ID is not set/);
      return true;
    },
  );
});

test("createActivity validates startTime format — rejects arbitrary string", async () => {
  const client = new TiimoClient({ token: "t", profileId: "p" });
  await assert.rejects(
    () => client.createActivity({ title: "test", startTime: "not-a-date", durationSec: 60 }),
    (err) => {
      assert(err instanceof TiimoError);
      assert.match(err.message, /startTime must be naive/);
      return true;
    },
  );
});

test("createActivity validates startTime format — rejects ISO8601 with Z suffix", async () => {
  const client = new TiimoClient({ token: "t", profileId: "p" });
  await assert.rejects(
    () =>
      client.createActivity({
        title: "test",
        startTime: "2026-06-05T10:00:00Z",
        durationSec: 60,
      }),
    (err) => err instanceof TiimoError,
  );
});

test("createActivity validates startTime format — rejects with milliseconds", async () => {
  const client = new TiimoClient({ token: "t", profileId: "p" });
  await assert.rejects(
    () =>
      client.createActivity({
        title: "test",
        startTime: "2026-06-05T10:00:00.000",
        durationSec: 60,
      }),
    (err) => err instanceof TiimoError,
  );
});

test("TiimoClient.deleteTaskList throws clear error when TIIMO_TOKEN is missing", async () => {
  const client = new TiimoClient({ token: "", profileId: "some-profile" });
  await assert.rejects(
    () => client.deleteTaskList("some-list-id"),
    (err) => {
      assert(err instanceof TiimoError, `expected TiimoError, got ${err}`);
      assert.match(err.message, /TIIMO_TOKEN is not set/);
      return true;
    },
  );
});

test("TiimoClient.deleteTaskList throws clear error when TIIMO_PROFILE_ID is missing", async () => {
  const client = new TiimoClient({ token: "some-token", profileId: "" });
  await assert.rejects(
    () => client.deleteTaskList("some-list-id"),
    (err) => {
      assert(err instanceof TiimoError);
      assert.match(err.message, /TIIMO_PROFILE_ID is not set/);
      return true;
    },
  );
});
