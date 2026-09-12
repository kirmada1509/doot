import type { AccessRole, AuthContext } from "@doot/contracts";

const roles: AccessRole[] = ["operator", "supervisor", "developer", "auditor", "admin"];

export function parseAccessRole(value: string | null | undefined): AccessRole | null {
  return roles.includes(value as AccessRole) ? (value as AccessRole) : null;
}

export function createDemoAuthContext(input: { role?: string | null; subject?: string | null }): AuthContext {
  return {
    subject: input.subject?.trim() || "demo-operator",
    role: parseAccessRole(input.role) ?? "operator",
    authMode: "demo-header"
  };
}

export function isAuthorized(auth: AuthContext, allowed: readonly AccessRole[]) {
  return auth.role === "admin" || allowed.includes(auth.role);
}

export function authorizationProblem(auth: AuthContext, allowed: readonly AccessRole[]) {
  return {
    title: "Insufficient role",
    code: "FORBIDDEN_ROLE",
    actorRole: auth.role,
    allowedRoles: allowed
  };
}
