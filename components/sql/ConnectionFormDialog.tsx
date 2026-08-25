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
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: PublicConnection | null;
  form: ConnectionForm;
  setForm: (form: ConnectionForm) => void;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit connection" : "Add connection"}</DialogTitle>
          <DialogDescription>
            Saved connections persist in the plugin database across reloads.
            A live test runs before save; failed tests are not stored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
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
          <Field label={editing ? "Password (leave blank to keep)" : "Password"}>
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={onSave}>
            {saving ? "Testing & saving…" : "Test & save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
