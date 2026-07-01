import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TiimoError,
  TiimoClient,
  uuidv7,
  readEnvValue,
  writeEnvValues,
  mergeRotatedCookie,
} from "./client.js";

function tmpEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tiimo-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf8");
  return path;
}

// Isolate the client's live-`.env` reads from the developer's real package .env
// (which carries a working token/cookie) so token-resolution tests are
// deterministic. In CI no .env exists, but locally one does.
process.env.TIIMO_ENV_FILE = tmpEnv("");

test("readEnvValue reads a key and strips surrounding quotes", () => {
  const p = tmpEnv('TIIMO_TOKEN="abc123"\nTIIMO_PROFILE_ID=pid\n');
  assert.equal(readEnvValue("TIIMO_TOKEN", p), "abc123");
  assert.equal(readEnvValue("TIIMO_PROFILE_ID", p), "pid");
});

test("readEnvValue keeps '=' and ';' inside a value (cookie header)", () => {
  const cookie = "a=1; __Secure-next-auth.session-token=ey.J=; b=2";
  const p = tmpEnv(`TIIMO_SESSION_COOKIE=${cookie}\n`);
  assert.equal(readEnvValue("TIIMO_SESSION_COOKIE", p), cookie);
});

test("readEnvValue returns undefined for a missing or empty key", () => {
  const p = tmpEnv("TIIMO_TOKEN=\n");
  assert.equal(readEnvValue("TIIMO_TOKEN", p), undefined);
  assert.equal(readEnvValue("NOPE", p), undefined);
});

test("writeEnvValues updates existing keys and preserves the rest", () => {
  const p = tmpEnv("# comment\nTIIMO_TOKEN=old\nTIIMO_PROFILE_ID=pid\n");
  writeEnvValues({ TIIMO_TOKEN: "new" }, p);
  const txt = readFileSync(p, "utf8");
  assert.match(txt, /^# comment$/m);
  assert.equal(readEnvValue("TIIMO_TOKEN", p), "new");
  assert.equal(readEnvValue("TIIMO_PROFILE_ID", p), "pid"); // untouched
});

test("writeEnvValues appends a missing key", () => {
  const p = tmpEnv("TIIMO_TOKEN=old\n");
  writeEnvValues({ TIIMO_SESSION_COOKIE: "c=1; d=2" }, p);
  assert.equal(readEnvValue("TIIMO_SESSION_COOKIE", p), "c=1; d=2");
  assert.equal(readEnvValue("TIIMO_TOKEN", p), "old");
});

test("mergeRotatedCookie updates a rotated session-token, ignores non-session cookies", () => {
  const current = "foo=1; __Secure-next-auth.session-token=OLD; bar=2";
  const merged = mergeRotatedCookie(current, [
    "__Secure-next-auth.session-token=NEW; Path=/; HttpOnly; Secure",
    "other=zzz; Path=/",
  ]);
  assert.equal(merged, "foo=1; __Secure-next-auth.session-token=NEW; bar=2");
});

test("mergeRotatedCookie handles chunked session cookies", () => {
  const current = "__Secure-next-auth.session-token.0=A0; __Secure-next-auth.session-token.1=A1";
  const merged = mergeRotatedCookie(current, [
    "__Secure-next-auth.session-token.0=B0; Path=/; Secure",
    "__Secure-next-auth.session-token.1=B1; Path=/; Secure",
  ]);
  assert.equal(
    merged,
    "__Secure-next-auth.session-token.0=B0; __Secure-next-auth.session-token.1=B1",
  );
});

test("mergeRotatedCookie drops a cleared session cookie", () => {
  const current = "keep=1; __Secure-next-auth.session-token=OLD";
  const merged = mergeRotatedCookie(current, [
    "__Secure-next-auth.session-token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]);
  assert.equal(merged, "keep=1");
});

test("mergeRotatedCookie returns null when nothing session-related changed", () => {
  const current = "__Secure-next-auth.session-token=SAME";
  assert.equal(mergeRotatedCookie(current, []), null);
  assert.equal(
    mergeRotatedCookie(current, ["__Secure-next-auth.session-token=SAME; Path=/"]),
    null,
  );
  assert.equal(mergeRotatedCookie(current, ["unrelated=x; Path=/"]), null);
});

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
