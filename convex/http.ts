import { FunctionArgs, httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { ActionCtx, httpAction } from "./_generated/server";
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
import { NOT_FOUND } from "../lib/api-contract";

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
type WriteRoute = (ctx: ActionCtx, write: WriteRequest, key: string) => Promise<Response>;

/** One method's routes by the path's action; `""` is the issue itself, with no action. */
type IssueRoutes<Route> = Partial<Record<IssueAction | "", Route>>;

/** The body, with the request's fields and the path's key over it, typed as a keyed mutation's arguments. */
const keyedArgs = <Args>({ body, fields }: WriteRequest, key: string) => uncheckedArgs<Args>(body, { ...fields, key });

/** Every `/api/v1/issues/{key}[/{action}]` route, by method and then by action. A pair that is not here is 404. */
const ISSUE_ROUTES = {
  GET: {
    "": async (ctx, agentName, key) => issueJson(200, await ctx.runQuery(internal.agentApi.getIssue, { agentName, key })),
    decisions: async (ctx, agentName, key) => json(200, await ctx.runQuery(internal.agentApi.listDecisions, { agentName, key })),
  },
  PATCH: {
    "": async (ctx, write, key) => issueJson(200, await ctx.runMutation(internal.agentApi.updateIssue, keyedArgs(write, key))),
  },
  POST: {
    proof: async (ctx, write, key) => issueJson(200, await ctx.runMutation(internal.agentApi.setProof, keyedArgs(write, key))),
    comments: async (ctx, write, key) => json(201, await ctx.runMutation(internal.agentApi.createComment, keyedArgs(write, key))),
    /** The create route's rules, with the story as parent. */
    subtasks: async (ctx, { body, fields }, key) =>
      issueJson(201, await ctx.runMutation(internal.agentApi.createIssue, uncheckedArgs(body, { ...fields, kind: "subtask", parentKey: key }))),
    /** Ask the owner; no route answers, so an agent never answers its own. */
    decisions: async (ctx, write, key) => json(201, await ctx.runMutation(internal.agentApi.askDecision, keyedArgs(write, key))),
  },
} satisfies { GET: IssueRoutes<ReadRoute>; PATCH: IssueRoutes<WriteRoute>; POST: IssueRoutes<WriteRoute> };

/** The route for the request's method and its path's action, with the key; the one 404 for a pair the table lacks. */
function issueRoute<Route>(routes: IssueRoutes<Route>, request: Request): { route: Route; key: string } {
  const pathname = new URL(request.url).pathname;
  const { key, action } = parseIssuePath(pathname);
  const route = routes[action ?? ""];
  if (route === undefined) {
    throw new HttpError(NOT_FOUND, `No ${request.method} route for ${pathname}`);
  }
  return { route, key };
}

const issueWrites = (routes: IssueRoutes<WriteRoute>) =>
  writeRoute(async (ctx, request, write) => {
    const { route, key } = issueRoute(routes, request);
    return await route(ctx, write, key);
  });

const issueReads = agentRoute(async (ctx, request, agentName) => {
  const { route, key } = issueRoute(ISSUE_ROUTES.GET, request);
  return await route(ctx, agentName, key);
});

http.route({ path: ISSUES_PATH, method: "POST", handler: writeRoute(createIssueRoute) });
http.route({ path: ISSUES_PATH, method: "GET", handler: agentRoute(listIssuesRoute) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "GET", handler: issueReads });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "PATCH", handler: issueWrites(ISSUE_ROUTES.PATCH) });
http.route({ pathPrefix: `${ISSUES_PATH}/`, method: "POST", handler: issueWrites(ISSUE_ROUTES.POST) });

export default http;
