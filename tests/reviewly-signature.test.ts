import { afterEach, describe, expect, test } from "bun:test";

import { Effect, Layer, ManagedRuntime, Stream } from "effect";

import { GitHub, GitHubLive, type ReviewEvent } from "../src/effect/services/GitHub";
import { PrefsService, prefsStore } from "../src/effect/services/Prefs";
import { Tauri, type TauriShape } from "../src/effect/Tauri";
import { withReviewlySignature } from "../src/lib/reviewly-signature";

const footer = '<sub>Posted by <a href="https://github.com/volnei/reviewly">Reviewly</a></sub>';
const ref = { owner: "acme", repo: "app", number: 42 };
const body = "Please rename this.  \n";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function harness(include: boolean) {
  let current = { ...prefsStore.get(), includeReviewlySignature: include };
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const tauri: TauriShape = {
    native: true,
    invoke: <A>(cmd: string, args: Record<string, unknown>) =>
      Effect.sync(() => {
        calls.push({ cmd, args });
        return undefined as A;
      }),
    listen: () => Effect.succeed(() => {}),
    events: () => Stream.empty,
  };
  const runtime = ManagedRuntime.make(
    GitHubLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Tauri, tauri),
          Layer.succeed(PrefsService, {
            get: Effect.sync(() => current),
            update: (f) => Effect.sync(() => (current = f(current))),
          }),
        ),
      ),
    ),
  );
  cleanups.push(() => runtime.dispose());
  return {
    calls,
    setInclude: (include: boolean) => {
      current = { ...current, includeReviewlySignature: include };
    },
    run: <A, E>(effect: Effect.Effect<A, E, GitHub>) => runtime.runPromise(effect),
  };
}

describe("Stored signature preferences", () => {
  test.each([
    ["legacy", undefined, false],
    ["enabled", true, true],
    ["disabled", false, false],
    ["invalid", "true", false],
  ])("restores %s settings without resetting other preferences", (_name, stored, expected) => {
    // A fresh process exercises startup decoding without sharing a singleton store.
    const raw = JSON.stringify({ wrapLines: false, includeReviewlySignature: stored });
    const result = Bun.spawnSync([
      process.execPath,
      "--eval",
      `
      globalThis.localStorage = {
        getItem: (key) => key === "reviewly.v2.prefs" ? ${JSON.stringify(raw)} : null,
      };
      const { prefsStore } = await import(${JSON.stringify(new URL("../src/effect/services/Prefs.ts", import.meta.url).pathname)});
      const { includeReviewlySignature, wrapLines } = prefsStore.get();
      console.log(JSON.stringify({ includeReviewlySignature, wrapLines }));
    `,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      includeReviewlySignature: expected,
      wrapLines: false,
    });
  });
});

describe("Reviewly signature formatting", () => {
  test("keeps content byte-for-byte when disabled, including existing signatures", () => {
    for (const text of [body, "", "  \n", `${body}\n${footer}`]) {
      expect(withReviewlySignature(text, false)).toBe(text);
    }
  });

  test("adds one linked signature after the content", () => {
    expect(withReviewlySignature(body, true)).toBe(`Please rename this.\n\n${footer}`);
  });

  test("does not duplicate or modify an existing signature on edits and retries", () => {
    const signed = `${body}\n${footer}\n`;
    expect(withReviewlySignature(signed, true)).toBe(signed);
  });

  test("signs an otherwise empty review", () => {
    expect(withReviewlySignature("", true)).toBe(footer);
    expect(withReviewlySignature("  \n", true)).toBe(footer);
  });
});

describe("GitHub outgoing signatures", () => {
  test.each([false, true])("comments, replies and edits respect include=%s", async (include) => {
    const h = harness(include);
    await h.run(
      Effect.gen(function* () {
        const g = yield* GitHub;
        yield* g.comment(ref, body);
        yield* g.createReviewComment(ref, {
          body,
          commitId: "head",
          path: "src/app.ts",
          line: 7,
          side: "RIGHT",
        });
        yield* g.reply(ref, 123, body);
        yield* g.editComment("issue", ref.owner, ref.repo, 123, body);
        yield* g.editComment("review", ref.owner, ref.repo, 123, body);
      }),
    );
    const outgoing = include ? `Please rename this.\n\n${footer}` : body;
    expect(h.calls).toEqual([
      { cmd: "gh_create_issue_comment", args: { ...ref, body: outgoing } },
      {
        cmd: "gh_create_review_comment",
        args: {
          ...ref,
          body: outgoing,
          commitId: "head",
          path: "src/app.ts",
          line: 7,
          side: "RIGHT",
        },
      },
      { cmd: "gh_reply_review_comment", args: { ...ref, commentId: 123, body: outgoing } },
      {
        cmd: "gh_edit_issue_comment",
        args: { owner: ref.owner, repo: ref.repo, commentId: 123, body: outgoing },
      },
      {
        cmd: "gh_edit_review_comment",
        args: { owner: ref.owner, repo: ref.repo, commentId: 123, body: outgoing },
      },
    ]);
  });

  for (const include of [false, true]) {
    test.each<ReviewEvent>(["APPROVE", "REQUEST_CHANGES", "COMMENT"])(
      `review %s and its inline drafts respect include=${include}`,
      async (event) => {
        const h = harness(include);
        const input = {
          body,
          event,
          commitId: "head",
          comments: [
            {
              body,
              path: "src/app.ts",
              line: 7,
              side: "RIGHT",
              start_line: 5,
              start_side: "RIGHT",
            },
          ],
        };
        const draft = structuredClone(input);
        await h.run(Effect.flatMap(GitHub, (g) => g.submitReview(ref, input)));
        const outgoing = include ? `Please rename this.\n\n${footer}` : body;
        expect(h.calls).toEqual([
          {
            cmd: "gh_submit_review",
            args: {
              ...ref,
              ...input,
              body: outgoing,
              comments: [{ ...input.comments[0], body: outgoing }],
            },
          },
        ]);
        expect(input).toEqual(draft);
      },
    );
  }

  test.each([false, true])("empty reviews respect include=%s", async (include) => {
    const h = harness(include);
    await h.run(
      Effect.flatMap(GitHub, (g) =>
        g.submitReview(ref, { body: "", event: "APPROVE", comments: [] }),
      ),
    );
    expect(h.calls[0].args).toEqual({
      ...ref,
      body: include ? footer : null,
      event: "APPROVE",
      comments: [],
      commitId: null,
    });
  });

  test("reads changed preferences when sending, without rebuilding the service or draft", async () => {
    const h = harness(false);
    const g = await h.run(GitHub);
    const post = g.comment(ref, body);
    h.setInclude(true);
    await h.run(post);
    h.setInclude(false);
    await h.run(post);
    expect(h.calls.map(({ args }) => args.body)).toEqual([
      `Please rename this.\n\n${footer}`,
      body,
    ]);
  });

  test("leaves existing signatures intact with either setting", async () => {
    const h = harness(true);
    const signed = `${body}\n${footer}\n`;
    const g = await h.run(GitHub);
    await h.run(g.editComment("issue", ref.owner, ref.repo, 123, signed));
    h.setInclude(false);
    await h.run(g.editComment("review", ref.owner, ref.repo, 123, signed));
    expect(h.calls.map(({ args }) => args.body)).toEqual([signed, signed]);
  });

  test("does not sign pull request descriptions", async () => {
    const h = harness(true);
    await h.run(Effect.flatMap(GitHub, (g) => g.updatePull(ref, { body })));
    expect(h.calls).toEqual([{ cmd: "gh_update_pr", args: { ...ref, title: null, body } }]);
  });
});
