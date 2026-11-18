import { createRouteMatcher } from "@clerk/nextjs/server";

/** Routes that need no Clerk session. `/mcp` names its agent by `X-Agent-Id`, the REST API's rule. */
export const PUBLIC_ROUTES = ["/sign-in(.*)", "/sign-up(.*)", "/mcp"];

export const isPublicRoute = createRouteMatcher(PUBLIC_ROUTES);
