import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient, Queryable } from "../db/client.js";

export type NotificationsFeedRouteDependencies = {
    resolveUserId(request: FastifyRequest): Promise<string>;
    database: DatabaseClient;
};

export type NotificationFeedItem = {
    id: string;
    category: string;
    status: string;
    title: string;
    explanation: string | null;
    resolved: boolean;
    projection: Record<string, unknown>;
    createdAt: string;
    eventAt: string;
    readAt: string | null;
};

/**
 * Authenticated notifications feed (Slice 5): list and mark-read for the
 * caller's own canonical notifications. Every query runs inside the resolved
 * owner's transaction so the wallet_notifications RLS policy applies.
 */
export async function registerNotificationsFeedRoutes(
    app: FastifyInstance,
    dependencies: NotificationsFeedRouteDependencies,
): Promise<void> {
    app.get(
        "/v1/notifications",
        async (
            request,
            reply,
        ): Promise<
            | { ok: true; data: NotificationFeedItem[] }
            | { ok: false; error: { code: string; message: string } }
        > => {
            let userId: string;
            try {
                userId = await dependencies.resolveUserId(request);
            } catch {
                return reply
                    .status(401)
                    .send({
                        ok: false,
                        error: {
                            code: "unauthorized",
                            message: "Authentication required.",
                        },
                    });
            }

            const rows = await dependencies.database.withUserTransaction(
                userId,
                (client: Queryable) =>
                    client.query<{
                        id: string;
                        category: string;
                        status: string;
                        title: string;
                        explanation: string | null;
                        resolved: boolean;
                        projection: Record<string, unknown>;
                        created_at: Date;
                        event_at: Date;
                        read_at: Date | null;
                    }>(
                        `SELECT id, category, status, title, explanation, resolved, projection,
                    created_at, event_at, read_at
             FROM wallet_notifications
             ORDER BY created_at DESC
             LIMIT 100`,
                    ),
            );

            return reply.send({
                ok: true,
                data: rows.rows.map((row) => ({
                    id: row.id,
                    category: row.category,
                    status: row.status,
                    title: row.title,
                    explanation: row.explanation,
                    resolved: row.resolved,
                    projection: row.projection,
                    createdAt: row.created_at.toISOString(),
                    eventAt: row.event_at.toISOString(),
                    readAt: row.read_at ? row.read_at.toISOString() : null,
                })),
            });
        },
    );

    app.post(
        "/v1/notifications/:id/read",
        async (
            request,
            reply,
        ): Promise<
            | { ok: true }
            | { ok: false; error: { code: string; message: string } }
        > => {
            let userId: string;
            try {
                userId = await dependencies.resolveUserId(request);
            } catch {
                return reply
                    .status(401)
                    .send({
                        ok: false,
                        error: {
                            code: "unauthorized",
                            message: "Authentication required.",
                        },
                    });
            }

            const { id } = request.params as { id?: string };
            if (!id) {
                return reply
                    .status(400)
                    .send({
                        ok: false,
                        error: {
                            code: "invalid_request",
                            message: "Notification id required.",
                        },
                    });
            }

            await dependencies.database.withUserTransaction(userId, (client) =>
                client.query(
                    `UPDATE wallet_notifications SET read_at = now()
           WHERE id = $1 AND read_at IS NULL`,
                    [id],
                ),
            );
            return reply.send({ ok: true });
        },
    );
}
