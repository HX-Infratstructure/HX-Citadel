import { FunctionArgs, httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { ActionCtx, httpAction } from "./_generated/server";
import { parseIssueKey } from "../lib/issue-key";
import {
  agentRoute,
  HttpError,
  IssueAction,
  issueJson,
  ISSUES_PATH,
  json,
  parseIssuePath,
  WriteRequest,
  writeRoute,
} from "./lib/httpApi";
import { NOT_FOUND, VALIDATION } from "../lib/api-contract";

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

/**
 * A JSON object, with the route's own fields over it, typed as the internal function's arguments. The type is a
 * claim, not a check: only the function's argument validator checks the object, and its refusal is a 400.
 */
const uncheckedArgs = <Args>(object: Record<string, unknown>, fields: Record<string, unknown>) => ({ ...object, ...fields }) as Args;

/** POST /api/v1/issues */
async function createIssueRoute(ctx: ActionCtx, _request: Request, { body, fields }: WriteRequest): Promise<Response> {
  const args = uncheckedArgs<CreateIssueArgs>(body, fields);
  return issueJson(201, await ctx.runMutation(internal.agentApi.createIssue, args));
}

/** GET /api/v1/issues?team=KEY&status=&assignee= (an agent name or `me`)&cursor= (the previous page's nextCursor) */
async function listIssuesRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const filters = Object.fromEntries(["status", "assignee", "cursor"].flatMap((name) => (query.has(name) ? [[name, query.get(name)]] : [])));
  const args = uncheckedArgs<FunctionArgs<typeof internal.agentApi.listIssues>>(filters, { agentName, teamKey: query.get("team") ?? undefined });
  return json(200, await ctx.runQuery(internal.agentApi.listIssues, args));
}

type ReadRoute = (ctx: ActionCtx, agentName: string, key: string) => Promise<Response>;

/** GET /api/v1/issues/{key}/decisions: the story's decision requests, newest first. */
async function listDecisionsRoute(ctx: ActionCtx, agentName: string, key: string): Promise<Response> {
  return json(200, await ctx.runQuery(internal.agentApi.listDecisions, { agentName, key }));
}

const ISSUE_READ_ROUTES: Partial<Record<IssueAction, ReadRoute>> = { decisions: listDecisionsRoute };

/** GET /api/v1/issues/{key}: a story or sub-task by its display key; GET /api/v1/issues/{key}/{action} by the read table. */
async function getIssueRoute(ctx: ActionCtx, request: Request, agentName: string): Promise<Response> {
  const { key, action } = parseIssuePath(new URL(request.url).pathname);
  if (action === null) {
    return issueJson(200, await ctx.runQuery(internal.agentApi.getIssue, { agentName, key }));
  }
  const route = ISSUE_READ_ROUTES[action];
  if (route === undefined) {
    throw new HttpError(NOT_FOUND, `No GET route for ${new URL(request.url).pathname}`);
  }
  return await route(ctx, agentName, key);
}

/** PATCH /api/v1/issues/{key}: any subset of status, assignee (a name or null), priority, title and description. */
async function updateIssueRoute(ctx: ActionCtx, request: Request, { body, fields }: WriteRequest): Promise<Response> {
  const { key } = issuePath(request, null);
  const args = uncheckedArgs<FunctionArgs<typeof internal.agentApi.updateIssue>>(body, { ...fields, key });
  return issueJson(200, await ctx.runMutation(internal.agentApi.updateIssue, args));
}

/** POST /api/v1/issues/{key}/proof */
async function setProofRoute(ctx: ActionCtx, { body, fields }: WriteRequest, key: string): Promise<Response> {
  const args = uncheckedArgs<FunctionArgs<typeof internal.agentApi.setProof>>(body, { ...fields, key });
  return issueJson(200, await ctx.runMutation(internal.agentApi.setProof, args));
}

/** POST /api/v1/issues/{key}/comments */
async function createCommentRoute(ctx: ActionCtx, { body, fields }: WriteRequest, key: string): Promise<Response> {
  const args = uncheckedArgs<FunctionArgs<typeof internal.agentApi.createComment>>(body, { ...fields, key });
  return json(201, await ctx.runMutation(internal.agentApi.createComment, args));
}

/** POST /api/v1/issues/{key}/subtasks: the create route's rules, with the story as parent. */
async function createSubtaskRoute(ctx: ActionCtx, { body, fields }: WriteRequest, key: string): Promise<Response> {
  const parsed = parseIssueKey(key);
  if (parsed === null) {
    throw new HttpError(VALIDATION, `invalid issue key ${key}; use KEY-12 or KEY-12.3`);
  }
  const args = uncheckedArgs<CreateIssueArgs>(body, { ...fields, teamKey: parsed.teamKey, kind: "subtask", parentKey: key });
  return issueJson(201, await ctx.runMutation(internal.agentApi.createIssue, args));
}

/** POST /api/v1/issues/{key}/decisions: ask the owner; no route answers, so an agent never answers its own. */
async function askDecisionRoute(ctx: ActionCtx, { body, fields }: WriteRequest, key: string): Promise<Response> {
  const args = uncheckedArgs<FunctionArgs<typeof internal.agentApi.askDecision>>(body, { ...fields, key });
  return json(201, await ctx.runMutation(internal.agentApi.askDecision, args));
}

type KeyedRoute = (ctx: ActionCtx, write: WriteRequest, key: string) => Promise<Response>;

const ISSUE_ACTION_ROUTES: Record<IssueAction, KeyedRoute> = {
  proof: setProofRoute,
  comments: createCommentRoute,
  subtasks: createSubtaskRoute,
  decisions: askDecisionRoute,
};

/** The key from `/api/v1/issues/{key}[/{action}]`; a path whose action differs from the route's is 404. */
function issuePath(request: Request, action: IssueAction | null): { key: string } {
  const path = parseIssuePath(new URL(request.url).pathname);
  if (path.action !== action) {
    throw new HttpError(NOT_FOUND, `No ${request.method} route for ${new URL(request.url).pathname}`);
  }
  return path;
}

/** POST /api/v1/issues/{key}/{action} */
async function issueActionRoute(ctx: ActionCtx, request: Request, write: WriteRequest): Promise<Response> {
  const { key, action } = parseIssuePath(new URL(request.url).pathname);
  if (action === null) {
    throw new HttpError(NOT_FOUND, `No POST route for ${ISSUES_PATH}/${key}`);
  }
  return await ISSUE_ACTION_ROUTES[action](ctx, write, key);
}

http.route({ path: ISSUES_PATH, method: "POST", handler: writeRoute(createIssueRoute) });
http.route({ path: ISSUES_PATH, method: "GET", handler: agentRoute(listIssuesRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "GET", handler: agentRoute(getIssueRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "PATCH", handler: writeRoute(updateIssueRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "POST", handler: writeRoute(issueActionRoute) });

export default http;
