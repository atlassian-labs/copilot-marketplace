const OPEN_SPRINT_JQL = "sprint in openSprints() ORDER BY priority DESC, Rank ASC";
const SEARCH_FIELDS = [
    "summary",
    "status",
    "assignee",
    "priority",
    "issuetype",
    "created",
    "updated",
    "resolutiondate",
    "duedate",
    "parent",
    "issuelinks",
    "labels",
    "components",
    "fixVersions",
    "sprint",
];
const PAGE_SIZE = 100;
const MAX_ISSUES = 2000;
const MAX_PAGES = 25;

const SEARCH_TOOL = "searchJiraIssuesUsingJql";
let cachedSearchMapping = null;

export class JiraDashboardError extends Error {
    constructor(code, publicMessage, cause) {
        super(publicMessage, cause ? { cause } : undefined);
        this.name = "JiraDashboardError";
        this.code = code;
        this.publicMessage = publicMessage;
    }
}

export function normalizeSiteOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.origin.toLowerCase() : "";
    } catch {
        return "";
    }
}

export function requireCanvasOpenInput(source) {
    const cloudId = typeof source?.cloudId === "string" ? source.cloudId.trim() : "";
    const siteUrl = normalizeSiteOrigin(source?.siteUrl);
    if (!cloudId || !siteUrl) {
        throw new JiraDashboardError(
            "jira_canvas_input_missing",
            "Resolved Jira site identifiers are required.",
        );
    }
    return { cloudId, siteUrl };
}

function toolName(tool) {
    return typeof tool?.name === "string" ? tool.name : "";
}

function selectSearchTool(tools) {
    const list = Array.isArray(tools) ? tools : [];
    const canonical = SEARCH_TOOL.toLowerCase();
    const exact = list.find((tool) => toolName(tool) === SEARCH_TOOL);
    if (exact) return toolName(exact);

    const namespaced = list.find((tool) => {
        const name = toolName(tool).toLowerCase();
        return name !== canonical && name.endsWith(canonical);
    });
    if (namespaced) return toolName(namespaced);

    const described = list.find((tool) => {
        const description = typeof tool?.description === "string"
            ? tool.description.toLowerCase()
            : "";
        return description.includes("jira")
            && description.includes("jql")
            && (description.includes("search") || description.includes("issue"));
    });
    return described ? toolName(described) : "";
}

async function discoverSearchMapping(session) {
    if (cachedSearchMapping) return cachedSearchMapping;

    let listing;
    try {
        listing = await session.rpc.mcp.list();
    } catch (error) {
        throw new JiraDashboardError(
            "jira_mcp_not_found",
            "Connect the Atlassian MCP server, then open the dashboard again.",
            error,
        );
    }

    const servers = Array.isArray(listing?.servers) ? listing.servers : [];
    const needsAuth = servers.some((server) => server?.status === "needs-auth");
    const connected = servers
        .filter((server) => server?.status === "connected" && typeof server?.name === "string")
        .sort((left, right) => {
            const leftPreferred = /atlassian/i.test(left.name) ? 0 : 1;
            const rightPreferred = /atlassian/i.test(right.name) ? 0 : 1;
            return leftPreferred - rightPreferred;
        });

    for (const server of connected) {
        try {
            const result = await session.rpc.mcp.listTools({ serverName: server.name });
            const searchToolName = selectSearchTool(result?.tools);
            if (searchToolName) {
                cachedSearchMapping = {
                    serverName: server.name,
                    searchToolName,
                };
                return cachedSearchMapping;
            }
        } catch {
            // Continue inspecting other connected servers.
        }
    }

    if (needsAuth) {
        throw new JiraDashboardError(
            "jira_mcp_auth_required",
            "Authenticate the Atlassian MCP connection, then open the dashboard again.",
        );
    }
    if (connected.length === 0) {
        throw new JiraDashboardError(
            "jira_mcp_not_found",
            "Connect the Atlassian MCP server, then open the dashboard again.",
        );
    }
    throw new JiraDashboardError(
        "jira_search_tool_not_found",
        "The connected MCP servers do not expose Jira JQL search.",
    );
}

function mappingMayBeStale(error) {
    const message = String(error?.message ?? "").toLowerCase();
    return message.includes("not connected")
        || message.includes("unknown tool")
        || message.includes("tool not found")
        || message.includes("server not found")
        || message.includes("no such tool");
}

async function callSearchTool(session, argumentsValue, mayRediscover = true) {
    const mapping = await discoverSearchMapping(session);
    try {
        return await session.rpc.mcp.apps.callTool({
            serverName: mapping.serverName,
            originServerName: mapping.serverName,
            toolName: mapping.searchToolName,
            arguments: argumentsValue,
        });
    } catch (error) {
        if (mayRediscover && mappingMayBeStale(error)) {
            cachedSearchMapping = null;
            return callSearchTool(session, argumentsValue, false);
        }
        const message = String(error?.message ?? "").toLowerCase();
        if (message.includes("auth") || message.includes("unauthorized")) {
            throw new JiraDashboardError(
                "jira_mcp_auth_required",
                "Authenticate the Atlassian MCP connection, then refresh the dashboard.",
                error,
            );
        }
        throw new JiraDashboardError(
            "jira_search_failed",
            "Jira search failed. Check the connection and try again.",
            error,
        );
    }
}

function parseJsonText(value) {
    if (typeof value !== "string") return value;
    const text = value.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    try {
        return JSON.parse(text);
    } catch {
        return value;
    }
}

function unwrapToolContent(result) {
    if (result?.isError) {
        throw new JiraDashboardError(
            "jira_search_failed",
            "Jira search returned an error. Check access and try again.",
        );
    }

    const payloads = [];
    for (const part of Array.isArray(result?.content) ? result.content : []) {
        if (part?.json && typeof part.json === "object") {
            payloads.push(part.json);
        } else if (typeof part?.text === "string") {
            const parsed = parseJsonText(part.text);
            if (typeof parsed !== "string") payloads.push(parsed);
        }
    }

    if (payloads.length === 1) return payloads[0];
    if (payloads.length === 0) {
        throw new JiraDashboardError(
            "jira_payload_invalid",
            "Jira returned data in an unsupported format.",
        );
    }

    const recognized = payloads.filter((payload) =>
        Array.isArray(payload)
        || Array.isArray(payload?.issues)
        || Array.isArray(payload?.values)
        || Array.isArray(payload?.resources));
    if (recognized.length === 1) return recognized[0];
    throw new JiraDashboardError(
        "jira_payload_invalid",
        "Jira returned ambiguous data.",
    );
}

function firstArray(...values) {
    return values.find(Array.isArray) ?? [];
}

function extractSearchPage(payload) {
    const issues = firstArray(
        payload?.issues?.nodes,
        payload?.issues,
        payload?.nodes,
        payload?.items,
        payload?.results,
        payload?.data?.issues,
        payload?.result?.issues,
        payload?.result?.items,
        Array.isArray(payload) ? payload : undefined,
    );
    const pageInfo = payload?.issues?.pageInfo ?? payload?.pageInfo ?? {};
    const token = payload?.nextPageToken
        ?? (pageInfo?.hasNextPage ? pageInfo?.endCursor : undefined);
    return {
        issues,
        nextPageToken: payload?.isLast ? null : token || null,
    };
}

export async function fetchOpenSprintIssues(session, identifiers) {
    const issuesByKey = new Map();
    const seenCursors = new Set();
    let nextPageToken = null;
    let partial = false;
    let partialReason = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const args = {
            cloudId: identifiers.cloudId,
            jql: OPEN_SPRINT_JQL,
            fields: SEARCH_FIELDS,
            maxResults: PAGE_SIZE,
        };
        if (nextPageToken) args.nextPageToken = nextPageToken;

        const result = await callSearchTool(session, args);
        const payload = unwrapToolContent(result);
        const pageData = extractSearchPage(payload);

        for (const issue of pageData.issues) {
            const key = typeof issue?.key === "string" ? issue.key.trim() : "";
            if (key) issuesByKey.set(key.toUpperCase(), issue);
            if (issuesByKey.size >= MAX_ISSUES) {
                partial = true;
                partialReason = "issue_limit";
                break;
            }
        }

        if (partial || !pageData.nextPageToken) break;
        if (seenCursors.has(pageData.nextPageToken)) {
            partial = true;
            partialReason = "cursor_loop";
            break;
        }
        seenCursors.add(pageData.nextPageToken);
        nextPageToken = pageData.nextPageToken;

        if (page === MAX_PAGES - 1) {
            partial = true;
            partialReason = "page_limit";
        }
    }

    return {
        issues: [...issuesByKey.values()],
        fetchedAt: new Date().toISOString(),
        partial,
        partialReason,
    };
}
