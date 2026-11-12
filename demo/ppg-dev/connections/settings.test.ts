import { describe, expect, it } from "vitest";

import {
  buildConnectionUrl,
  defaultConnectionName,
  detectKindFromUrl,
  maskConnectionUrl,
  parseConnectionInput,
  redactSecrets,
} from "./settings";

describe("connection settings", () => {
  it("builds Postgres and MySQL URLs from host fields, encoding credentials", () => {
    expect(
      buildConnectionUrl({
        database: "school",
        host: "db.example.com",
        kind: "postgres",
        password: "p@ss/word",
        user: "admin",
      }),
    ).toBe("postgresql://admin:p%40ss%2Fword@db.example.com:5432/school");
    expect(
      buildConnectionUrl({ host: "localhost", kind: "mysql", user: "root" }),
    ).toBe("mysql://root@localhost:3306");
  });

  it("validates host, port and URL scheme against the chosen kind", () => {
    expect(() =>
      buildConnectionUrl({ host: "bad host", kind: "postgres" }),
    ).toThrow(/valid host/);
    expect(() =>
      buildConnectionUrl({ host: "localhost", kind: "mysql", port: 70000 }),
    ).toThrow(/port/);
    expect(() =>
      buildConnectionUrl({ kind: "mysql", url: "postgres://x@localhost/db" }),
    ).toThrow(/mysql:\/\//);
    expect(
      buildConnectionUrl({ kind: "mysql", url: "mariadb://root@host/app" }),
    ).toBe("mysql://root@host/app");
  });

  it("only accepts absolute SQLite paths and strips file: prefixes", () => {
    expect(
      buildConnectionUrl({ file: "file:/tmp/dev.db", kind: "sqlite" }),
    ).toBe("/tmp/dev.db");
    expect(() =>
      buildConnectionUrl({ file: "dev.db", kind: "sqlite" }),
    ).toThrow(/absolute path/);
  });

  it("detects kinds from URLs", () => {
    expect(detectKindFromUrl("postgresql://a@b/c")).toBe("postgres");
    expect(detectKindFromUrl("mysql://a@b/c")).toBe("mysql");
    expect(detectKindFromUrl("file:./dev.db")).toBe("sqlite");
    expect(detectKindFromUrl("redis://x")).toBeNull();
  });

  it("never exposes passwords to the browser", () => {
    const url = "postgresql://admin:s3cret@localhost:5432/app";

    expect(maskConnectionUrl("postgres", url)).toBe(
      "postgresql://admin:****@localhost:5432/app",
    );
    expect(redactSecrets('password authentication failed "s3cret"', url)).toBe(
      'password authentication failed "****"',
    );
    expect(defaultConnectionName("postgres", url)).toBe("app @ localhost");
    expect(defaultConnectionName("sqlite", "/x/y/dev.db")).toBe("dev.db");
  });

  it("parses form payloads", () => {
    expect(
      parseConnectionInput({
        host: "localhost",
        kind: "postgres",
        name: "  Shop  ",
        port: "5433",
        user: "me",
      }),
    ).toEqual({
      database: undefined,
      host: "localhost",
      kind: "postgres",
      name: "Shop",
      password: undefined,
      port: 5433,
      user: "me",
    });
    expect(() => parseConnectionInput({ kind: "oracle" })).toThrow();
  });
});
