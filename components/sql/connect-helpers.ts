/** Хелпер Connect/Reconnect с запросом пароля, если секрет не сохранён. */

type ConnectOutcome = {
  ok: boolean;
  error?: string;
  needsPassword?: boolean;
};

type RpcLike = {
  call(
    method: "connectConnection" | "reconnectConnection",
    input: { id: string; password?: string },
  ): Promise<ConnectOutcome>;
  call(
    method: "updateConnection",
    input: {
      id: string;
      name: string;
      host: string;
      port: number;
      database: string;
      user: string;
      password?: string;
      ssl: boolean;
      sslCaPath?: string | null;
      sslCertPath?: string | null;
      sslKeyPath?: string | null;
    },
  ): Promise<unknown>;
};

/**
 * Пробует connect/reconnect; при needsPassword спрашивает пароль и опционально сохраняет.
 */
export async function connectOrReconnectWithPasswordPrompt(options: {
  rpc: RpcLike;
  method: "connectConnection" | "reconnectConnection";
  connection: {
    id: string;
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    ssl: boolean;
    sslCaPath?: string | null;
    sslCertPath?: string | null;
    sslKeyPath?: string | null;
    hasPassword: boolean;
  };
}): Promise<ConnectOutcome> {
  const { rpc, method, connection } = options;

  const first = await rpc.call(method, { id: connection.id });
  if (first.ok || !first.needsPassword) {
    return first;
  }

  const entered = window.prompt(
    `Password for "${connection.name}" (Cancel to abort; empty OK for trust auth):`,
  );
  if (entered === null) {
    return { ok: false, error: "Password prompt cancelled" };
  }

  const second = await rpc.call(method, {
    id: connection.id,
    password: entered,
  });
  if (!second.ok) {
    return second;
  }

  if (
    !connection.hasPassword &&
    window.confirm(`Save password for "${connection.name}" in plugin secrets (0600 file)?`)
  ) {
    await rpc.call("updateConnection", {
      id: connection.id,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: entered,
      ssl: connection.ssl,
      sslCaPath: connection.sslCaPath ?? null,
      sslCertPath: connection.sslCertPath ?? null,
      sslKeyPath: connection.sslKeyPath ?? null,
    });
  }

  return second;
}
