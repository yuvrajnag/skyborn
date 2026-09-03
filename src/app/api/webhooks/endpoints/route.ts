import { NextResponse } from "next/server";

import { errorResponse, readJson, requireString } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { authenticateDevApp } from "@/server/grants";
import { WEBHOOK_EVENTS, WebhookError, createEndpoint } from "@/server/webhooks";

/** Register a webhook endpoint for a DevApp. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const devApp = await authenticateDevApp(
      requireString(body, "client_id"),
      requireString(body, "client_secret"),
    );

    const { endpoint, secret } = await createEndpoint({
      devAppId: devApp.id,
      url: requireString(body, "url"),
      events: Array.isArray(body.events) ? body.events.map(String) : [],
    });

    return NextResponse.json(
      {
        endpoint_id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        // Shown once. It is what a receiver verifies signatures with.
        secret,
        signature_header: "Skyborn-Signature",
        known_events: WEBHOOK_EVENTS,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof WebhookError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 },
      );
    }
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const devApp = await authenticateDevApp(
      url.searchParams.get("client_id") ?? "",
      url.searchParams.get("client_secret") ?? "",
    );

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { devAppId: devApp.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      endpoints: endpoints.map((endpoint) => ({
        endpoint_id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        active: endpoint.active,
        created_at: endpoint.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
