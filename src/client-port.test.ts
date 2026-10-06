import { describe, expect, it } from "vitest";
import { OpenCode } from "@opencode/client";
import type { OpenCodeClient } from "@opencode/client";
import { asClientPort, type OpencodeClientPort } from "./client-port.js";

// Compile-time assertions: the generated client must satisfy the port
// structurally, in both directions of use. These lines are the test; they
// fail `tsc`/editor checks (and vitest transform on gross breakage) when the
// pinned beta's surface drifts from the port.
type Satisfies<T extends U, U> = T;
export type _ClientSatisfiesPort = Satisfies<
  OpenCodeClient,
  OpencodeClientPort
>;

describe("client-port", () => {
  it("OpenCode.make's client satisfies OpencodeClientPort structurally", () => {
    const client = OpenCode.make({ baseUrl: "http://127.0.0.1:0" });
    const port: OpencodeClientPort = client;
    expect(port).toBe(client);
  });

  it("asClientPort returns the same client instance", () => {
    const client = OpenCode.make({ baseUrl: "http://127.0.0.1:0" });
    expect(asClientPort(client)).toBe(client);
  });

  it("exposes exactly the surfaces the provider needs", () => {
    const port = asClientPort(OpenCode.make({ baseUrl: "http://127.0.0.1:0" }));

    expect(typeof port.server.info).toBe("function");
    expect(typeof port.session.create).toBe("function");
    expect(typeof port.session.get).toBe("function");
    expect(typeof port.session.prompt).toBe("function");
    expect(typeof port.session.wait).toBe("function");
    expect(typeof port.session.interrupt).toBe("function");
    expect(typeof port.session.switchModel).toBe("function");
    expect(typeof port.session.switchAgent).toBe("function");
    expect(typeof port.session.message.get).toBe("function");
    expect(typeof port.session.context).toBe("function");
    expect(typeof port.session.log).toBe("function");
    expect(typeof port.session.inbox.cancel).toBe("function");
    expect(typeof port.session.inbox.list).toBe("function");
    expect(typeof port.message.list).toBe("function");
    expect(typeof port.model.list).toBe("function");
    expect(typeof port.generate.text).toBe("function");
    expect(typeof port.event.subscribe).toBe("function");
    expect(typeof port.permission.list).toBe("function");
    expect(typeof port.permission.get).toBe("function");
    expect(typeof port.permission.reply).toBe("function");
    expect(typeof port.session.form.list).toBe("function");
    expect(typeof port.session.form.reply).toBe("function");
    expect(typeof port.session.form.cancel).toBe("function");
    expect(typeof port.migration.v1.status).toBe("function");
  });
});
