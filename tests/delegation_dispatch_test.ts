import type { SlackAPIClient } from "deno-slack-api/types.ts";
import {
  delegationEndpoint,
  dispatchDelegation,
  isDelegationEndpoint,
} from "../delebot/slack/delegation_dispatch.ts";
import { assert } from "./task_fixtures.ts";

Deno.test("delegation workflow endpoint is created once and reused from its dedicated datastore", async () => {
  let url: string | undefined;
  let creates = 0;
  const client = {
    apps: {
      datastore: {
        get: () => Promise.resolve({ ok: true, item: { url } }),
        put: ({ item }: { item: { url: string } }) => {
          url = item.url;
          return Promise.resolve({ ok: true });
        },
      },
    },
    workflows: {
      triggers: {
        create: (
          { workflow, inputs }: { workflow: string; inputs: Record<string, unknown> },
        ) => {
          creates++;
          assert(workflow === "#/workflows/delebot_delegate" && "submission" in inputs);
          return Promise.resolve({
            ok: true,
            trigger: {
              webhook_url: "https://hooks.slack.com/triggers/TTEST/FTEST/secret",
            },
          });
        },
      },
    },
  } as unknown as SlackAPIClient;
  const endpoints = await Promise.all([
    delegationEndpoint(client),
    delegationEndpoint(client),
  ]);
  assert(creates === 1 && endpoints[0] === endpoints[1] && endpoints[0] === url);
});

Deno.test("delegation endpoint refuses unrelated URLs and failed provisioning", async () => {
  for (
    const url of [
      "http://hooks.slack.com/triggers/a",
      "https://example.com/triggers/a",
      "https://hooks.slack.com.evil.test/triggers/a",
      "https://hooks.slack.com/services/a",
      "https://hooks.slack.com/triggers/a?redirect=evil",
    ]
  ) assert(!isDelegationEndpoint(url));
  const client = {
    apps: { datastore: { get: () => Promise.resolve({ ok: true, item: {} }) } },
    workflows: {
      triggers: { create: () => Promise.resolve({ ok: false, error: "missing_scope" }) },
    },
  } as unknown as SlackAPIClient;
  let failed = false;
  try {
    await delegationEndpoint(client);
  } catch {
    failed = true;
  }
  assert(failed);
});

Deno.test("delegation handoff awaits Slack acceptance, forbids redirects, and has a two-second deadline", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (_url, options) => {
      calls++;
      assert(
        options?.method === "POST" && options.redirect === "error" &&
          options.signal instanceof AbortSignal,
      );
      const body = JSON.parse(options.body as string);
      assert(body.user_id === "UALICE" && body.channel_id === "DALICE");
      assert(JSON.parse(body.submission).viewId === "VTEST");
      return Promise.resolve(
        new Response(JSON.stringify({ ok: calls === 1 }), {
          status: calls === 1 ? 200 : 429,
        }),
      );
    };
    await dispatchDelegation(
      "https://hooks.slack.com/triggers/TTEST/FTEST/secret",
      { viewId: "VTEST" },
      "DALICE",
      "UALICE",
    );
    let failed = false;
    try {
      await dispatchDelegation(
        "https://hooks.slack.com/triggers/TTEST/FTEST/secret",
        { viewId: "VTEST" },
        "DALICE",
        "UALICE",
      );
    } catch {
      failed = true;
    }
    assert(failed && calls === 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a stalled Slack handoff aborts before the modal response deadline", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (_url, options) =>
      new Promise<Response>((resolve, reject) => {
        const fallback = setTimeout(() => resolve(new Response('{"ok":true}')), 5000);
        options!.signal!.addEventListener("abort", () => {
          clearTimeout(fallback);
          reject(options!.signal!.reason);
        }, { once: true });
      });
    const started = performance.now();
    let timedOut = false;
    try {
      await dispatchDelegation(
        "https://hooks.slack.com/triggers/TTEST/FTEST/secret",
        {},
        "DALICE",
        "UALICE",
      );
    } catch (error) {
      timedOut = error instanceof DOMException && error.name === "TimeoutError";
    }
    assert(
      timedOut && performance.now() - started < 2900,
      "The modal must receive a recoverable error before Slack's three-second deadline",
    );
  } finally {
    globalThis.fetch = original;
  }
});
