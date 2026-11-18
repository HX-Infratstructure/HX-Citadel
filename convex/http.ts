import { FunctionArgs, httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { ActionCtx, httpAction } from "./_generated/server";
import { agentRoute, json, readJsonObject } from "./lib/httpApi";

const http = httpRouter();

type ClerkEvent = {
  type: string;
  data: Record<string, unknown>;
};

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      console.error("CLERK_WEBHOOK_SECRET is not set");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const payload = await request.text();

    let event: ClerkEvent;
    try {
      const wh = new Webhook(secret);
      event = wh.verify(payload, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ClerkEvent;
    } catch (error) {
      console.error("Clerk webhook verification failed", error);
      return new Response("Verification failed", { status: 400 });
    }

    await ctx.runMutation(internal.webhooks.handleClerkEvent, {
      eventType: event.type,
      data: event.data,
    });

    return new Response(null, { status: 200 });
  }),
});

const ISSUES_PATH = "/api/v1/issues";

/** POST /api/v1/issues: the internal mutation's validators parse the body. */
async function createIssueRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const body = await readJsonObject(request);
  const args = { ...body, agentName } as FunctionArgs<typeof internal.agentApi.createIssue>;
  return json(201, await ctx.runMutation(internal.agentApi.createIssue, args));
}

/** GET /api/v1/issues/{key}: a story or sub-task by its display key. */
async function getIssueRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname.slice(ISSUES_PATH.length + 1));
  return json(200, await ctx.runQuery(internal.agentApi.getIssue, { agentName, key }));
}

http.route({ path: ISSUES_PATH, method: "POST", handler: agentRoute(createIssueRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "GET", handler: agentRoute(getIssueRoute) });

export default http;
