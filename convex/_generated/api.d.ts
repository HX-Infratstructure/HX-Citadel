/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as admin from "../admin.js";
import type * as agentApi from "../agentApi.js";
import type * as attachments from "../attachments.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as cycles from "../cycles.js";
import type * as http from "../http.js";
import type * as issueRelations from "../issueRelations.js";
import type * as issues from "../issues.js";
import type * as labels from "../labels.js";
import type * as lib_activity from "../lib/activity.js";
import type * as lib_agents from "../lib/agents.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_customFunctions from "../lib/customFunctions.js";
import type * as lib_httpApi from "../lib/httpApi.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_issueCleanup from "../lib/issueCleanup.js";
import type * as lib_issueVersion from "../lib/issueVersion.js";
import type * as lib_mirror from "../lib/mirror.js";
import type * as lib_orgScope from "../lib/orgScope.js";
import type * as lib_rules_doneGate from "../lib/rules/doneGate.js";
import type * as lib_rules_levels from "../lib/rules/levels.js";
import type * as lib_rules_testing from "../lib/rules/testing.js";
import type * as lib_rules_wip from "../lib/rules/wip.js";
import type * as mirror from "../mirror.js";
import type * as organizations from "../organizations.js";
import type * as presenceFns from "../presenceFns.js";
import type * as projects from "../projects.js";
import type * as search from "../search.js";
import type * as seed from "../seed.js";
import type * as teams from "../teams.js";
import type * as users from "../users.js";
import type * as views from "../views.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  admin: typeof admin;
  agentApi: typeof agentApi;
  attachments: typeof attachments;
  comments: typeof comments;
  crons: typeof crons;
  cycles: typeof cycles;
  http: typeof http;
  issueRelations: typeof issueRelations;
  issues: typeof issues;
  labels: typeof labels;
  "lib/activity": typeof lib_activity;
  "lib/agents": typeof lib_agents;
  "lib/auth": typeof lib_auth;
  "lib/customFunctions": typeof lib_customFunctions;
  "lib/httpApi": typeof lib_httpApi;
  "lib/idempotency": typeof lib_idempotency;
  "lib/issueCleanup": typeof lib_issueCleanup;
  "lib/issueVersion": typeof lib_issueVersion;
  "lib/mirror": typeof lib_mirror;
  "lib/orgScope": typeof lib_orgScope;
  "lib/rules/doneGate": typeof lib_rules_doneGate;
  "lib/rules/levels": typeof lib_rules_levels;
  "lib/rules/testing": typeof lib_rules_testing;
  "lib/rules/wip": typeof lib_rules_wip;
  mirror: typeof mirror;
  organizations: typeof organizations;
  presenceFns: typeof presenceFns;
  projects: typeof projects;
  search: typeof search;
  seed: typeof seed;
  teams: typeof teams;
  users: typeof users;
  views: typeof views;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  presence: import("@convex-dev/presence/_generated/component.js").ComponentApi<"presence">;
};
