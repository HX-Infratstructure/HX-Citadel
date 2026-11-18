import { FunctionArgs, httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { ActionCtx, httpAction } from "./_generated/server";
import { parseIssueKey } from "../lib/issue-key";
import {
  agentRoute,
  HttpError,
  IssueAction,
  ISSUES_PATH,
  json,
  parseIssuePath,
  readJsonObject,
} from "./lib/httpApi";

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

type CreateIssueArgs = FunctionArgs<typeof internal.agentApi.createIssue>;

/** The internal mutation's validators parse what the body leaves after the route's own fields. */
const bodyArgs = <Args>(body: Record<string, unknown>, fields: Record<string, unknown>) => ({ ...body, ...fields }) as Args;

/** POST /api/v1/issues */
async function createIssueRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const args = bodyArgs<CreateIssueArgs>(await readJsonObject(request), { agentName });
  return json(201, await ctx.runMutation(internal.agentApi.createIssue, args));
}

/** GET /api/v1/issues?team=KEY&status=&assignee= (an agent name or `me`) */
async function listIssuesRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const filters = Object.fromEntries(["status", "assignee"].flatMap((name) => (query.has(name) ? [[name, query.get(name)]] : [])));
  const args = bodyArgs<FunctionArgs<typeof internal.agentApi.listIssues>>(filters, { agentName, teamKey: query.get("team") ?? undefined });
  return json(200, await ctx.runQuery(internal.agentApi.listIssues, args));
}

/** GET /api/v1/issues/{key}: a story or sub-task by its display key. */
async function getIssueRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const { key } = issuePath(request, null);
  return json(200, await ctx.runQuery(internal.agentApi.getIssue, { agentName, key }));
}

/** PATCH /api/v1/issues/{key}: any subset of status, assignee (a name or null), priority, title and description. */
async function updateIssueRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const { key } = issuePath(request, null);
  const args = bodyArgs<FunctionArgs<typeof internal.agentApi.updateIssue>>(await readJsonObject(request), { agentName, key });
  return json(200, await ctx.runMutation(internal.agentApi.updateIssue, args));
}

/** POST /api/v1/issues/{key}/proof */
async function setProofRoute(ctx: ActionCtx, request: Request, agentName: string, key: string): Promise<Response> {
  const args = bodyArgs<FunctionArgs<typeof internal.agentApi.setProof>>(await readJsonObject(request), { agentName, key });
  return json(200, await ctx.runMutation(internal.agentApi.setProof, args));
}

/** POST /api/v1/issues/{key}/comments */
async function createCommentRoute(ctx: ActionCtx, request: Request, agentName: string, key: string): Promise<Response> {
  const args = bodyArgs<FunctionArgs<typeof internal.agentApi.createComment>>(await readJsonObject(request), { agentName, key });
  return json(201, await ctx.runMutation(internal.agentApi.createComment, args));
}

/** POST /api/v1/issues/{key}/subtasks: the create route's rules, with the story as parent. */
async function createSubtaskRoute(ctx: ActionCtx, request: Request, agentName: string, key: string): Promise<Response> {
  const parsed = parseIssueKey(key);
  if (parsed === null) {
    throw new HttpError(400, "validation", `invalid issue key ${key}; use KEY-12 or KEY-12.3`);
  }
  const fields = { agentName, teamKey: parsed.teamKey, kind: "subtask", parentKey: key };
  const args = bodyArgs<CreateIssueArgs>(await readJsonObject(request), fields);
  return json(201, await ctx.runMutation(internal.agentApi.createIssue, args));
}

type KeyedRoute = (ctx: ActionCtx, request: Request, agentName: string, key: string) => Promise<Response>;

const ISSUE_ACTION_ROUTES: Record<IssueAction, KeyedRoute> = {
  proof: setProofRoute,
  comments: createCommentRoute,
  subtasks: createSubtaskRoute,
};

/** The key from `/api/v1/issues/{key}[/{action}]`; a path whose action differs from the route's is 404. */
function issuePath(request: Request, action: IssueAction | null): { key: string } {
  const path = parseIssuePath(new URL(request.url).pathname);
  if (path.action !== action) {
    throw new HttpError(404, "not_found", `No ${request.method} route for ${new URL(request.url).pathname}`);
  }
  return path;
}

/** POST /api/v1/issues/{key}/{action} */
async function issueActionRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const { key, action } = parseIssuePath(new URL(request.url).pathname);
  if (action === null) {
    throw new HttpError(404, "not_found", `No POST route for ${ISSUES_PATH}/${key}`);
  }
  return await ISSUE_ACTION_ROUTES[action](ctx, request, agentName, key);
}

http.route({ path: ISSUES_PATH, method: "POST", handler: agentRoute(createIssueRoute) });
http.route({ path: ISSUES_PATH, method: "GET", handler: agentRoute(listIssuesRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "GET", handler: agentRoute(getIssueRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "PATCH", handler: agentRoute(updateIssueRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "POST", handler: agentRoute(issueActionRoute) });

export default http;
