import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/RouteStates";
import { api, queryKeys } from "@/lib/api";
import type { DelegatedGrant } from "@/lib/api-types";

/**
 * DGC-6: delegated grants surface (Slice 1). The grants channel is the
 * authenticated HTTP API only — never voice (D-3). Creating or revoking a
 * grant is an explicit user act in this screen; the assistant narrates state
 * but can never mutate it.
 */

function formatLimit(amount: string): string {
  // Decimal string in smallest units → readable display (lamports for MVP).
  const normalized = amount.replace(/_/g, "");
  const big = BigInt(normalized);
  return big.toLocaleString("es-AR");
}

function GrantCard({
  grant,
  onRevoke,
  revoking,
}: {
  grant: DelegatedGrant;
  onRevoke: (grantId: string) => void;
  revoking: boolean;
}) {
  return (
    <article className="rounded-2xl border border-foreground/10 bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Transferencias delegadas ({grant.chain})</span>
        <span
          className={
            grant.state === "active"
              ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
              : "rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
          }
        >
          {grant.state === "active" ? "Activa" : grant.state === "revoked" ? "Revocada" : "Vencida"}
        </span>
      </div>
      <dl className="mt-3 space-y-1 text-sm text-muted-foreground">
        <div className="flex justify-between">
          <dt>Máximo por transferencia</dt>
          <dd className="font-mono">{formatLimit(grant.maxPerTransfer)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tope acumulado</dt>
          <dd className="font-mono">{formatLimit(grant.maxCumulative)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Ventana</dt>
          <dd>
            {grant.windowSeconds >= 3600
              ? `${Math.round(grant.windowSeconds / 3600)} h`
              : `${grant.windowSeconds} s`}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Vence</dt>
          <dd>{new Date(grant.expiresAt).toLocaleDateString("es-AR")}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Destinatarios autorizados</dt>
          <dd>{grant.recipients.length}</dd>
        </div>
      </dl>
      {grant.state === "active" && (
        <Button
          variant="outline"
          className="mt-4 w-full"
          disabled={revoking}
          onClick={() => onRevoke(grant.id)}
        >
          {revoking ? "Revocando…" : "Revocar autorización"}
        </Button>
      )}
    </article>
  );
}

export function DelegatedGrantsSection({ userId }: { userId: string | undefined }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const grantsQuery = useQuery({
    queryKey: queryKeys.grants(userId),
    queryFn: api.listGrants,
    enabled: Boolean(userId),
  });

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) => api.revokeGrant(grantId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.grants(userId) });
    },
    onError: () => {
      setError("No pudimos revocar la autorización. Probá de nuevo en un ratito.");
    },
  });

  if (grantsQuery.isLoading) {
    return (
      <section className="mt-6" aria-busy="true">
        <h2 className="text-base font-semibold">Autorizaciones delegadas</h2>
        <p className="mt-2 text-sm text-muted-foreground">Cargando autorizaciones…</p>
      </section>
    );
  }

  if (grantsQuery.isError || !grantsQuery.data) {
    return (
      <section className="mt-6">
        <h2 className="text-base font-semibold">Autorizaciones delegadas</h2>
        <EmptyState>No pudimos leer tus autorizaciones. Probá de nuevo en un ratito.</EmptyState>
      </section>
    );
  }

  const grants = grantsQuery.data.grants;

  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold">Autorizaciones delegadas</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Podés permitir que Nani haga transferencias dentro de un límite, sin confirmar cada vez.
        Todo lo que exceda la autorización te pide confirmación como siempre. Podés revocar cuando
        quieras.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {grants.length === 0 ? (
        <EmptyState>
          Todavía no tenés autorizaciones delegadas. Cada transferencia te va a pedir confirmación
          explícita.
        </EmptyState>
      ) : (
        <div className="mt-3 space-y-3">
          {grants.map((grant) => (
            <GrantCard
              key={grant.id}
              grant={grant}
              onRevoke={(grantId) => revokeMutation.mutate(grantId)}
              revoking={revokeMutation.isPending && revokeMutation.variables === grant.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}
