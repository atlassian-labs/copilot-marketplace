import assert from "node:assert/strict";
import test from "node:test";

import {
    fetchOpenSprintIssues,
    requireCanvasOpenInput,
} from "../server/jira-client.mjs";

test("normalizes and validates canvas site input", () => {
    assert.deepEqual(
        requireCanvasOpenInput({
            cloudId: " cloud-123 ",
            siteUrl: "https://Example.Atlassian.net/path",
        }),
        {
            cloudId: "cloud-123",
            siteUrl: "https://example.atlassian.net",
        },
    );
    assert.throws(
        () => requireCanvasOpenInput({ cloudId: "", siteUrl: "http://example.com" }),
        { code: "jira_canvas_input_missing" },
    );
});

test("paginates authoritative MCP content and ignores structuredContent", async () => {
    const calls = [];
    const issue = (key) => ({ key, fields: { summary: key } });
    const session = {
        rpc: {
            mcp: {
                list: async () => ({
                    servers: [{ name: "atlassian-rovo", status: "connected" }],
                }),
                listTools: async () => ({
                    tools: [{ name: "mcp__atlassian__searchJiraIssuesUsingJql" }],
                }),
                apps: {
                    callTool: async (args) => {
                        calls.push(args);
                        const page = calls.length === 1
                            ? {
                                issues: [issue("DASH-1")],
                                nextPageToken: "page-2",
                                isLast: false,
                            }
                            : {
                                issues: [issue("DASH-2")],
                                isLast: true,
                            };
                        return {
                            content: [{ type: "text", text: JSON.stringify(page) }],
                            structuredContent: {
                                issues: { nodes: [issue("IGNORED-99")] },
                            },
                        };
                    },
                },
            },
        },
    };

    const result = await fetchOpenSprintIssues(session, {
        cloudId: "cloud-123",
        siteUrl: "https://example.atlassian.net",
    });

    assert.deepEqual(result.issues.map(({ key }) => key), ["DASH-1", "DASH-2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].arguments.nextPageToken, "page-2");
    assert.ok(calls.every((call) => call.serverName === call.originServerName));
});
