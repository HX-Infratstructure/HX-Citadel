import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { issueKindValidator, issuePriorityValidator, issueStatusValidator, issueTypeValidator } from "../../convex/schema";
import { type ApiBody, CitadelApi, issuePath, toolResult, type WriteOptions } from "../citadel-api";

/** A zod enum over a Convex literal union, so the tool schemas reuse `convex/schema.ts`. */
const literals = <T extends string>(validator: { members: { value: T }[] }) => z.enum(validator.members.map((member) => member.value));

const status = literals(issueStatusValidator);
const priority = literals(issuePriorityValidator);
const key = z.string().min(1).describe("The issue key, such as HX-12 or HX-12.1");
const writeShape = {
  idempotencyKey: z.string().min(1).describe("Sent as Idempotency-Key; a replay returns the stored result"),
};
const editShape = {
  ...writeShape,
  ifMatch: z.number().int().positive().optional().describe("The version last read; a stale one is refused with code stale"),
};

/** Splits a write tool's arguments into the REST body and its headers. */
function writeArgs<T extends WriteOptions>({ idempotencyKey, ifMatch, ...body }: T): [ApiBody, WriteOptions] {
  return [body, { idempotencyKey, ifMatch }];
}

/** The MCP server for one agent: seven tools, each one REST call. */
/** Every tool the server registers, by name; the live checker asserts `tools/list` returns exactly these. */
export const MCP_TOOL = {
  listIssues: "list_issues",
  getIssue: "get_issue",
  createIssue: "create_issue",
  updateIssue: "update_issue",
  setProof: "set_proof",
  addComment: "add_comment",
  addSubtask: "add_subtask",
} as const;
export const MCP_TOOL_NAMES: string[] = Object.values(MCP_TOOL);

export function createCitadelMcpServer(api: CitadelApi): McpServer {
  const server = new McpServer({ name: "hx-citadel", version: "1.0.0" });

  server.registerTool(
    MCP_TOOL.listIssues,
    {
      description: "GET /api/v1/issues: a team's issues, filtered by status or assignee (an agent name or me)",
      inputSchema: { team: z.string().min(1), status: status.optional(), assignee: z.string().optional() },
    },
    (args) => toolResult(() => api.get(issuePath(), args))
  );

  server.registerTool(
    MCP_TOOL.getIssue,
    { description: "GET /api/v1/issues/{key}: a story with its sub-tasks, or one sub-task", inputSchema: { key } },
    (args) => toolResult(() => api.get(issuePath(args.key)))
  );

  server.registerTool(
    MCP_TOOL.createIssue,
    {
      description: "POST /api/v1/issues: create an issue; a new story gets its testing sub-task .1",
      inputSchema: {
        ...writeShape,
        teamKey: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        kind: literals(issueKindValidator).optional(),
        type: literals(issueTypeValidator).optional(),
        status: status.optional(),
        priority: priority.optional(),
        parentKey: z.string().optional(),
        assignee: z.string().optional(),
      },
    },
    (args) => toolResult(() => api.write("POST", issuePath(), ...writeArgs(args)))
  );

  server.registerTool(
    MCP_TOOL.updateIssue,
    {
      description: "PATCH /api/v1/issues/{key}: any subset of status, assignee (a name or null), priority, title and description",
      inputSchema: {
        ...editShape,
        key,
        title: z.string().optional(),
        description: z.string().optional(),
        status: status.optional(),
        priority: priority.optional(),
        assignee: z.string().nullable().optional(),
      },
    },
    ({ key: issueKey, ...args }) => toolResult(() => api.write("PATCH", issuePath(issueKey), ...writeArgs(args)))
  );

  server.registerTool(
    MCP_TOOL.setProof,
    { description: "POST /api/v1/issues/{key}/proof: set the proof link", inputSchema: { ...editShape, key, proofUrl: z.string().min(1) } },
    ({ key: issueKey, ...args }) => toolResult(() => api.write("POST", issuePath(issueKey, "proof"), ...writeArgs(args)))
  );

  server.registerTool(
    MCP_TOOL.addComment,
    { description: "POST /api/v1/issues/{key}/comments: comment on an issue", inputSchema: { ...editShape, key, body: z.string().min(1) } },
    ({ key: issueKey, ...args }) => toolResult(() => api.write("POST", issuePath(issueKey, "comments"), ...writeArgs(args)))
  );

  server.registerTool(
    MCP_TOOL.addSubtask,
    {
      description: "POST /api/v1/issues/{key}/subtasks: add a sub-task to a story",
      inputSchema: { ...editShape, key, title: z.string().min(1), status: status.optional() },
    },
    ({ key: issueKey, ...args }) => toolResult(() => api.write("POST", issuePath(issueKey, "subtasks"), ...writeArgs(args)))
  );

  return server;
}
