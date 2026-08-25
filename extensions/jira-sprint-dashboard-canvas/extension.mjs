import { createServer } from "node:http";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import {
    JiraDashboardError,
    fetchOpenSprintIssues,
    requireCanvasOpenInput,
} from "./server/jira-client.mjs";
import {
    buildDashboardModel,
    markDashboardStale,
    renderDashboardHtml,
} from "./ui/dashboard.mjs";
import {
    StartCopilotError,
    startCopilotForIssue,
} from "./server/start-copilot.mjs";

const instances = new Map();
const MAX_REQUEST_BODY_SIZE = 16 * 1024;
let resolveSessionReady;
const sessionReady = new Promise((resolve) => {
    resolveSessionReady = resolve;
});

function publicCanvasError(error, fallbackCode = "jira_dashboard_failed") {
    if (error instanceof JiraDashboardError) {
        return new CanvasError(error.code, error.publicMessage);
    }
    if (error instanceof StartCopilotError) {
        return new CanvasError(error.code, error.publicMessage);
    }
    if (error instanceof CanvasError) return error;
    return new CanvasError(fallbackCode, "The Jira sprint dashboard could not be loaded.");
}

function writeJson(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

function notifyRefresh(entry) {
    for (const client of entry.eventClients) {
        client.write("data: refresh\n\n");
    }
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BODY_SIZE) {
            throw new CanvasError(
                "jira_request_too_large",
                "Request payload is too large.",
            );
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new CanvasError(
            "jira_request_invalid_json",
            "Request payload must be valid JSON.",
        );
    }
}

async function startInstanceServer(instanceId) {
    const server = createServer((request, response) => {
        const entry = instances.get(instanceId);
        if (!entry) {
            writeJson(response, 410, { status: "closed" });
            return;
        }

        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && requestUrl.pathname === "/data.json") {
            writeJson(response, 200, entry.model);
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/events") {
            response.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
                "X-Content-Type-Options": "nosniff",
            });
            response.write(": connected\n\n");
            entry.eventClients.add(response);
            request.on("close", () => entry.eventClients.delete(response));
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/") {
            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            });
            response.end(renderDashboardHtml(entry.model));
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/start-with-copilot") {
            void (async () => {
                try {
                    const body = await readJsonBody(request);
                    const activeSession = await sessionReady;
                    const started = await startCopilotForIssue(
                        activeSession,
                        entry,
                        body?.issueKey,
                    );
                    writeJson(response, 200, { status: "success", ...started });
                } catch (error) {
                    const canvasError = publicCanvasError(
                        error,
                        "jira_start_with_copilot_failed",
                    );
                    const clientErrorCodes = new Set([
                        "jira_issue_key_invalid",
                        "jira_issue_not_in_dashboard",
                        "jira_request_invalid_json",
                        "jira_request_too_large",
                    ]);
                    writeJson(response, clientErrorCodes.has(canvasError.code) ? 400 : 500, {
                        status: "error",
                        code: canvasError.code,
                        message: canvasError.message,
                    });
                }
            })();
            return;
        }

        writeJson(response, 404, { status: "not_found" });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise((resolve) => server.close(resolve));
        throw new CanvasError("jira_canvas_server_failed", "The dashboard server could not start.");
    }
    return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function loadFreshModel(identifiers) {
    const activeSession = await sessionReady;
    const result = await fetchOpenSprintIssues(activeSession, identifiers);
    return buildDashboardModel(
        result.issues,
        identifiers.siteUrl,
        result.fetchedAt,
        result.partial,
    );
}

async function refreshEntry(entry) {
    const model = await loadFreshModel(entry.identifiers);
    entry.model = model;
    notifyRefresh(entry);
    return model;
}

async function closeInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) return;
    instances.delete(instanceId);
    for (const client of entry.eventClients) client.end();
    entry.eventClients.clear();
    await new Promise((resolve) => entry.server.close(resolve));
}

const dashboardCanvas = createCanvas({
    id: "jira-sprint-dashboard-canvas",
    displayName: "Jira Sprint Dashboard",
    description: "A live, read-only dashboard for Jira issues in currently open sprints.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["cloudId", "siteUrl"],
        properties: {
            cloudId: { type: "string", minLength: 1 },
            siteUrl: { type: "string", pattern: "^https://" },
        },
    },
    actions: [
        {
            name: "refresh_dashboard",
            description: "Refresh the dashboard from Jira while retaining last-good data if refresh fails.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
            },
            handler: async (context) => {
                const entry = instances.get(context.instanceId);
                if (!entry) {
                    throw new CanvasError(
                        "jira_canvas_instance_not_found",
                        "Open the Jira sprint dashboard before refreshing it.",
                    );
                }
                try {
                    const model = await refreshEntry(entry);
                    return {
                        status: "success",
                        refreshedAt: model.context.refreshedAt,
                        counts: Object.fromEntries(model.stats.map((stat) => [stat.label, stat.value])),
                    };
                } catch (error) {
                    entry.model = markDashboardStale(entry.model);
                    notifyRefresh(entry);
                    const canvasError = publicCanvasError(error, "jira_refresh_failed");
                    return {
                        status: "error",
                        code: canvasError.code,
                        message: "Refresh failed; the dashboard is showing its last successful data.",
                    };
                }
            },
        },
    ],
    open: async (context) => {
        const existing = instances.get(context.instanceId);
        let identifiers;
        try {
            identifiers = requireCanvasOpenInput(context.input);
            const model = await loadFreshModel(identifiers);
            let entry = existing;
            if (!entry) {
                const serverInfo = await startInstanceServer(context.instanceId);
                entry = {
                    ...serverInfo,
                    identifiers,
                    model,
                    eventClients: new Set(),
                };
                instances.set(context.instanceId, entry);
            } else {
                entry.identifiers = identifiers;
                entry.model = model;
                notifyRefresh(entry);
            }
            return {
                title: "Jira Sprint Dashboard",
                status: model.quality.partial ? "Partial Jira data" : "Live Jira data",
                url: entry.url,
            };
        } catch (error) {
            const isSameSite = existing
                && identifiers
                && existing.identifiers.cloudId === identifiers.cloudId
                && existing.identifiers.siteUrl === identifiers.siteUrl;
            if (isSameSite) {
                existing.model = markDashboardStale(existing.model);
                notifyRefresh(existing);
                return {
                    title: "Jira Sprint Dashboard",
                    status: "Stale Jira data",
                    url: existing.url,
                };
            }
            throw publicCanvasError(error);
        }
    },
    onClose: async (context) => {
        await closeInstance(context.instanceId);
    },
});

const session = await joinSession({
    enableMcpApps: true,
    canvases: [dashboardCanvas],
});
resolveSessionReady(session);
