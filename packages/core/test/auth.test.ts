import { describe, expect, it } from "vitest";
import { authorizationProblem, createDemoAuthContext, isAuthorized, parseAccessRole } from "../src/index";

describe("access roles", () => {
  it("parses known roles and rejects unknown values", () => {
    expect(parseAccessRole("auditor")).toBe("auditor");
    expect(parseAccessRole("caseworker")).toBeNull();
  });

  it("uses an operator demo context when no identity is supplied", () => {
    expect(createDemoAuthContext({}).role).toBe("operator");
    expect(createDemoAuthContext({ role: "developer", subject: "dev-1" })).toMatchObject({
      role: "developer",
      subject: "dev-1",
      authMode: "demo-header"
    });
  });

  it("authorizes admins globally and reports denied roles", () => {
    expect(isAuthorized(createDemoAuthContext({ role: "admin" }), ["auditor"])).toBe(true);
    expect(isAuthorized(createDemoAuthContext({ role: "operator" }), ["auditor"])).toBe(false);
    expect(authorizationProblem(createDemoAuthContext({ role: "operator" }), ["auditor"]).code).toBe("FORBIDDEN_ROLE");
  });
});
