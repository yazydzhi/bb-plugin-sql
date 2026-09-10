import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parsePostgresUri } from "@/lib/parse-postgres-uri";
import type { ConnectionForm, PublicConnection } from "./types";

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={className ? `grid gap-1 ${className}` : "grid gap-1"}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ConnectionFormDialog({
  open,
  onOpenChange,
  editing,
  form,
  setForm,
  saving,
  testing,
  onTest,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: PublicConnection | null;
  form: ConnectionForm;
  setForm: (form: ConnectionForm) => void;
  saving: boolean;
  testing: boolean;
  onTest: () => void;
  onSave: () => void;
}) {
  const busy = saving || testing;

  function applyUri() {
    const parsed = parsePostgresUri(form.uriPaste);
    if (!parsed) {
      window.alert("Paste a postgresql:// or postgres:// URI");
      return;
    }
    setForm({
      ...form,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      password: parsed.password.length > 0 ? parsed.password : form.password,
      ssl: parsed.ssl || form.ssl,
      uriPaste: "",
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit connection" : "Add connection"}</DialogTitle>
          <DialogDescription>
            Passwords are stored in a 0600 secrets file next to the plugin database —
            not in SQLite and not sent to the browser after save.
            {editing
              ? " Use Test to check credentials. Save still works if the server is down (e.g. Access flags)."
              : " A live test runs before save; you can confirm to save anyway if it fails."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <Field label="Paste connection URI (optional)">
            <div className="flex gap-2">
              <Input
                value={form.uriPaste}
                onChange={(event) =>
                  setForm({ ...form, uriPaste: event.target.value })
                }
                placeholder="postgresql://user:pass@host:5432/db?sslmode=require"
              />
              <Button type="button" variant="outline" onClick={applyUri} disabled={busy}>
                Apply
              </Button>
            </div>
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="local"
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Host" className="col-span-2">
              <Input
                value={form.host}
                onChange={(event) => setForm({ ...form, host: event.target.value })}
              />
            </Field>
            <Field label="Port">
              <Input
                value={form.port}
                onChange={(event) => setForm({ ...form, port: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Database">
            <Input
              value={form.database}
              onChange={(event) => setForm({ ...form, database: event.target.value })}
            />
          </Field>
          <Field label="User">
            <Input
              value={form.user}
              onChange={(event) => setForm({ ...form, user: event.target.value })}
            />
          </Field>
          <Field
            label={
              editing
                ? editing.hasPassword
                  ? "Password (leave blank to keep)"
                  : "Password (not stored yet)"
                : "Password (empty OK for trust auth)"
            }
          >
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.ssl}
              onChange={(event) => setForm({ ...form, ssl: event.target.checked })}
            />
            Use SSL
          </label>
          {form.ssl ? (
            <div className="grid gap-2 rounded border border-border p-2">
              <p className="text-xs text-muted-foreground">
                Optional PEM paths on the bb host (verify-full style when CA is set).
              </p>
              <Field label="CA path">
                <Input
                  value={form.sslCaPath}
                  onChange={(event) =>
                    setForm({ ...form, sslCaPath: event.target.value })
                  }
                  placeholder="/path/to/ca.pem"
                />
              </Field>
              <Field label="Client cert path">
                <Input
                  value={form.sslCertPath}
                  onChange={(event) =>
                    setForm({ ...form, sslCertPath: event.target.value })
                  }
                  placeholder="/path/to/client-cert.pem"
                />
              </Field>
              <Field label="Client key path">
                <Input
                  value={form.sslKeyPath}
                  onChange={(event) =>
                    setForm({ ...form, sslKeyPath: event.target.value })
                  }
                  placeholder="/path/to/client-key.pem"
                />
              </Field>
            </div>
          ) : null}
          <div className="grid gap-2 rounded border border-border p-2">
            <p className="text-xs font-medium">Access</p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.accessMode === "readonly"}
                onChange={(event) =>
                  setForm({
                    ...form,
                    accessMode: event.target.checked ? "readonly" : "readwrite",
                  })
                }
              />
              <span>
                Read-only
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Default is read/write. Enable to block INSERT/UPDATE/DELETE in the UI.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.agentWrite}
                onChange={(event) =>
                  setForm({ ...form, agentWrite: event.target.checked })
                }
              />
              <span>
                Agent write
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Off by default. Allows agent <code>sql_query</code> to run DML on
                  this connection (and DDL if Allow DDL is also on).
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.allowDdl}
                onChange={(event) =>
                  setForm({ ...form, allowDdl: event.target.checked })
                }
              />
              <span>
                Allow DDL
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Off by default. Permits CREATE/ALTER/DROP/TRUNCATE/… in the UI.
                  Agent also needs Agent write.
                </span>
              </span>
            </label>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            {editing ? (
              <Button variant="outline" disabled={busy} onClick={onTest}>
                {testing ? "Testing…" : "Test"}
              </Button>
            ) : null}
            <Button disabled={busy} onClick={onSave}>
              {saving
                ? editing
                  ? "Saving…"
                  : "Testing & saving…"
                : editing
                  ? "Save"
                  : "Test & save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
