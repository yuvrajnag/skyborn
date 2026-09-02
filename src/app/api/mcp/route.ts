import { NextResponse } from "next/server";

import { CoreError } from "@/server/core";
import { GrantError, authenticateBearer, bearerFromRequest } from "@/server/grants";
import { callTool, readResource, resourcesFor, toolsFor } from "@/server/mcp";

/**
 * The MCP endpoint (spec Section 13), speaking JSON-RPC 2.0 over Streamable
 * HTTP.
 *
 * Stateless by design: every request carries its own bearer token and is
 * resolved to a Grant on its own, so there is no server-side session to keep,
 * expire, or leak between callers. That also means a revoked grant stops
 * working on the very next call rather than when some session eventually ages
 * out.
 *
 * Protocol version 2025-11-25, matching @modelcontextprotocol/sdk 1.30.0.
 * Older clients that negotiate 2025-06-18 or 2025-03-26 are answered in the
 * version they asked for.
 */

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const SERVER_INFO = { name: "skyborn", title: "Skyborn", version: "1.0.0" };

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

/**
 * A 401 here must carry WWW-Authenticate pointing at the protected-resource
 * metadata — that is how an MCP client discovers where to go and starts the
 * OAuth flow rather than simply failing.
 */
function unauthorized(request: Request, message: string) {
  const origin = process.env.NEXTAUTH_URL ?? new URL(request.url).origin;
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

export async function GET(request: Request) {
  // No server-initiated stream: this server is stateless and pushes nothing.
  return unauthorizedOrMethodNotAllowed(request);
}

async function unauthorizedOrMethodNotAllowed(request: Request) {
  try {
    await authenticateBearer(bearerFromRequest(request));
  } catch {
    return unauthorized(request, "Authentication required.");
  }
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "This server does not offer a server-initiated stream." } },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(request: Request) {
  let body: {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  };

  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error.", 400);
  }

  const id = body.id ?? null;
  const method = body.method;
  const params = body.params ?? {};

  if (!method) return rpcError(id, -32600, "Invalid request: no method.", 400);

  // `initialize` and `ping` are answered without a token, so a client can
  // discover the server and be told how to authenticate.
  if (method === "initialize") {
    const asked = String(params.protocolVersion ?? LATEST_PROTOCOL_VERSION);
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
      ? asked
      : LATEST_PROTOCOL_VERSION;

    return result(id, {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Skyborn acts for one verified human's agent. Tools are limited to the scopes that human approved, " +
        "and money-moving calls are capped server-side. Amounts are integer paise as strings: ₹1 is \"100\".",
    });
  }

  if (method === "ping") return result(id, {});

  // A notification carries no id and expects no response.
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202 });
  }

  let grant;
  try {
    grant = await authenticateBearer(bearerFromRequest(request));
  } catch (error) {
    return unauthorized(
      request,
      error instanceof GrantError ? error.message : "Authentication required.",
    );
  }

  try {
    switch (method) {
      case "tools/list":
        return result(id, { tools: toolsFor(grant) });

      case "tools/call": {
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;

        try {
          const value = await callTool(grant, name, args);
          return result(id, {
            content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
            isError: false,
          });
        } catch (error) {
          // A refused tool call is a result, not a transport error: the model
          // needs to read why and decide what to do, and an -32603 would just
          // look like the server broke.
          const message =
            error instanceof CoreError || error instanceof GrantError
              ? `${error.code}: ${error.message}`
              : "The call failed.";
          if (!(error instanceof CoreError) && !(error instanceof GrantError)) {
            console.error("MCP tool error:", error);
          }
          return result(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      case "resources/list":
        return result(id, { resources: resourcesFor(grant) });

      case "resources/read": {
        const uri = String(params.uri ?? "");
        const value = await readResource(grant, uri);
        return result(id, {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
        });
      }

      case "prompts/list":
        return result(id, { prompts: [] });

      default:
        return rpcError(id, -32601, `Method "${method}" is not supported.`);
    }
  } catch (error) {
    if (error instanceof CoreError || error instanceof GrantError) {
      return rpcError(id, -32602, `${error.code}: ${error.message}`);
    }
    console.error("MCP error:", error);
    return rpcError(id, -32603, "Internal error.");
  }
}
