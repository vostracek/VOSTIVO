/**
 * TEST-ONLY, imported by source path. `createDatabaseClient` has no close of
 * its own, so a client opened per test stays connected until the test process
 * exits. Tracking them here keeps parallel test files under the server's
 * connection limit without changing what any test does.
 */
// `Database` does not declare `$client`, but drizzle's postgres-js client has it at runtime.
interface ClosableDatabaseClient {
  readonly $client: { end(options?: { timeout?: number }): Promise<void> };
}

export interface TestDatabaseClients<Client> {
  readonly create: (connectionString: string) => Client;
  readonly closeAll: () => Promise<void>;
}

const CLOSE_TIMEOUT_SECONDS = 5;

export function createTestDatabaseClients<Client>(open: (connectionString: string) => Client): TestDatabaseClients<Client> {
  const clients: Client[] = [];

  return {
    create: (connectionString) => {
      const client = open(connectionString);
      clients.push(client);
      return client;
    },
    closeAll: async () => {
      const closing = clients.splice(0);
      await Promise.all(closing.map((client) => (client as unknown as ClosableDatabaseClient).$client.end({ timeout: CLOSE_TIMEOUT_SECONDS })));
    },
  };
}
