import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as advancePOST } from "@/app/api/demo/transfers/[id]/advance/route";
import { resetEnvCache } from "@/config/env";
import { resetNotifierForTests } from "@/notifications/ntfy";
import {
  apiRequest,
  describeDb,
  idCtx,
  newKey,
  readJson,
  seedSessionWithQuote,
  useApiTestDb,
  type TestSession,
} from "../server/helpers";
import { body, create, fund, get } from "./client";

const advance = (s: TestSession, id: string) =>
  advancePOST(apiRequest(`/api/demo/transfers/${id}/advance`, { cookie: s.cookie, body: {} }), idCtx(id));

describeDb("recipient notification (ntfy)", () => {
  const t = useApiTestDb();
  let ntfyCalls: { url: string; init: RequestInit }[];
  let ntfyStatus: number;
  const realFetch = globalThis.fetch;

  function setTopic(topic: string | undefined) {
    if (topic === undefined) delete process.env.NTFY_TOPIC;
    else process.env.NTFY_TOPIC = topic;
    resetEnvCache();
    resetNotifierForTests();
  }

  beforeEach(() => {
    ntfyCalls = [];
    ntfyStatus = 200;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://ntfy.sh/")) {
        ntfyCalls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: ntfyStatus });
      }
      return realFetch(url, init);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setTopic(undefined);
  });

  async function complete(scenario = "HAPPY_PATH") {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote, scenario)))).data.id as string;
    await fund(session, id, newKey());
    let data = {} as { status?: string; nextAction?: string; notification: { channel: string; status: string; sentAt: string | null } };
    for (let i = 0; i < 20; i++) {
      data = (await readJson(await advance(session, id))).data;
      if (data.nextAction !== "ADVANCE") break;
    }
    return { session, id, data };
  }

  it("snapshot carries notification NOT_STARTED before completion", async () => {
    setTopic("demo_topic_x");
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const snap = (await readJson(await get(session, id))).data;
    expect(snap.notification).toEqual({ channel: "NTFY", status: "NOT_STARTED", sentAt: null });
  });

  it("sends one ntfy push when the transfer completes and records SENT", async () => {
    setTopic("demo_topic_x");
    const { session, id, data } = await complete();
    expect(data.status).toBe("COMPLETED_SIMULATED");
    expect(data.notification.channel).toBe("NTFY");
    expect(data.notification.status).toBe("SENT");
    expect(typeof data.notification.sentAt).toBe("string");
    expect(ntfyCalls).toHaveLength(1);
    expect(ntfyCalls[0]!.url).toBe("https://ntfy.sh/demo_topic_x");
    expect(String(ntfyCalls[0]!.init.body)).toContain("THB 343.00");

    // Further advance calls and GETs never re-send.
    await advance(session, id);
    const again = (await readJson(await get(session, id))).data;
    expect(again.notification.status).toBe("SENT");
    expect(ntfyCalls).toHaveLength(1);
  });

  it("records FAILED without blocking completion, and a later advance retries", async () => {
    setTopic("demo_topic_x");
    ntfyStatus = 503;
    const { session, id, data } = await complete();
    expect(data.status).toBe("COMPLETED_SIMULATED");
    expect(data.nextAction).toBe("NONE");
    expect(data.notification).toMatchObject({ status: "FAILED", sentAt: null });

    ntfyStatus = 200;
    const res = await advance(session, id);
    expect(res.status).toBe(200);
    const after = (await readJson(res)).data;
    expect(after.notification.status).toBe("SENT");
    expect(after.status).toBe("COMPLETED_SIMULATED");
    expect(ntfyCalls).toHaveLength(2);
  });

  it("is DISABLED and sends nothing when no topic is configured", async () => {
    setTopic(undefined);
    const { data } = await complete();
    expect(data.status).toBe("COMPLETED_SIMULATED");
    expect(data.notification).toEqual({ channel: "NTFY", status: "DISABLED", sentAt: null });
    expect(ntfyCalls).toHaveLength(0);
  });

  it("does not notify when the transfer does not complete", async () => {
    setTopic("demo_topic_x");
    const { data } = await complete("FUNDING_DECLINED");
    expect(data.status).toBe("FUNDING_FAILED");
    expect(data.notification.status).toBe("NOT_STARTED");
    expect(ntfyCalls).toHaveLength(0);
  });
});
