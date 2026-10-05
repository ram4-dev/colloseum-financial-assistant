import { createFileRoute } from "@tanstack/react-router";
import { Bell, Check, RefreshCw } from "lucide-react";

import { RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api";
import { useNotificationsFeed } from "@/features/notifications/useNotificationsFeed";

export const Route = createFileRoute("/notificaciones")({
  head: () => ({ meta: [{ title: "Notificaciones | Nana Wallet" }] }),
  component: NotificationsPage,
});

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function NotificationsPage() {
  const feed = useNotificationsFeed();

  if (feed.isLoading && feed.items.length === 0) {
    return <RoutePending label="Estamos buscando tus notificaciones" />;
  }

  return (
    <main className="mx-auto max-w-md px-6 pt-12 pb-40" data-testid="notifications-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Notificaciones</h1>
          <p className="mt-1 text-base text-muted-foreground">
            {feed.unreadCount === 0
              ? "Estás al día."
              : `${feed.unreadCount} ${feed.unreadCount === 1 ? "pendiente" : "pendientes"} por leer.`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="press min-h-12 shrink-0"
          aria-label="Actualizar notificaciones"
          onClick={() => void feed.refresh()}
        >
          <RefreshCw className="size-5" aria-hidden="true" />
          Actualizar
        </Button>
      </div>

      {feed.error ? (
        <section className="surface-card mt-5 p-5" role="alert">
          <h2 className="text-xl font-extrabold">No pudimos cargar la bandeja</h2>
          <p className="mt-2 text-base text-muted-foreground">{getErrorMessage(feed.error)}</p>
          <Button className="press mt-4 min-h-12 w-full" onClick={() => void feed.refresh()}>
            Probar de nuevo
          </Button>
        </section>
      ) : null}

      {feed.isEmpty && !feed.error ? (
        <section className="surface-card mt-6 p-6 text-center" data-testid="notifications-empty">
          <Bell className="mx-auto size-10 text-brand-ink" aria-hidden="true" />
          <h2 className="mt-3 text-xl font-extrabold">Todavía no hay novedades</h2>
          <p className="mt-2 text-base text-muted-foreground">
            Acá vas a ver las confirmaciones de tus transferencias y la actividad detectada en tu
            wallet.
          </p>
        </section>
      ) : null}

      <ul className="mt-5 space-y-3" aria-label="Actividad reciente">
        {feed.items.map((item) => (
          <li key={item.id}>
            <article
              className={`surface-card p-5 ${item.readAt === null ? "border-brand-ink/40" : ""}`}
              data-testid="notification-item"
              data-status={item.status}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-extrabold">{item.title}</h2>
                  {item.explanation ? (
                    <p className="mt-1 text-base text-muted-foreground">{item.explanation}</p>
                  ) : null}
                </div>
                {item.readAt === null ? (
                  <span className="rounded-full bg-primary/20 px-3 py-1 text-xs font-extrabold text-brand-ink">
                    Nueva
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-sm font-bold text-muted-foreground">
                {formatDate(item.eventAt)}
              </p>
              {item.readAt === null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="press mt-4 min-h-12 w-full"
                  onClick={() => void feed.markRead(item.id)}
                  aria-label={`Marcar como leída: ${item.title}`}
                >
                  <Check className="size-5" aria-hidden="true" />
                  Marcar como leída
                </Button>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
