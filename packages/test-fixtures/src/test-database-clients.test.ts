import { describe, expect, it, vi } from "vitest";
import { createTestDatabaseClients } from "./test-database-clients.js";

function fakeClient() {
  return { $client: { end: vi.fn(() => Promise.resolve()) } };
}

describe("createTestDatabaseClients", () => {
  it("passes the connection string through and returns the opened client", () => {
    const client = fakeClient();
    const open = vi.fn(() => client);

    expect(createTestDatabaseClients(open).create("url")).toBe(client);
    expect(open).toHaveBeenCalledWith("url");
  });

  it("closes every client it opened, exactly once", async () => {
    const opened = [fakeClient(), fakeClient()];
    let next = 0;
    const clients = createTestDatabaseClients(() => opened[next++]!);
    clients.create("url");
    clients.create("url");

    await clients.closeAll();
    await clients.closeAll();

    for (const client of opened) expect(client.$client.end).toHaveBeenCalledTimes(1);
  });
});
