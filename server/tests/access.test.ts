import { describe, expect, it } from "vitest";

import { accessFromRole, canSeeCustomer, canSeeRecord } from "../src/http/access.ts";
import { ALL_PERM_KEYS, sanitizeDataScope, sanitizePermissions } from "../src/http/permissions.ts";

describe("permissions", () => {
  it("keeps only known keys and implies view from write", () => {
    expect(sanitizePermissions(["records.write", "nope"])).toEqual(["records.view", "records.write"]);
  });

  it("normalizes data scope", () => {
    expect(sanitizeDataScope("all")).toBe("all");
    expect(sanitizeDataScope("assigned")).toBe("assigned");
    expect(sanitizeDataScope("")).toBe("assigned");
  });

  it("admin role has every permission and all customers", () => {
    const access = accessFromRole({
      code: "admin",
      name: "管理员",
      builtin: true,
      dataScope: "all",
      permissions: ALL_PERM_KEYS,
    });
    expect(access.has("roles.manage")).toBe(true);
    expect(access.allCustomers).toBe(true);
  });

  it("custom role only has listed permissions", () => {
    const access = accessFromRole({
      code: "r_abc",
      name: "自定义",
      builtin: false,
      dataScope: "assigned",
      permissions: ["records.view"],
    });
    expect(access.has("records.view")).toBe(true);
    expect(access.has("users.manage")).toBe(false);
    expect(access.allCustomers).toBe(false);
  });

  it("treats null scope as all customers", () => {
    expect(canSeeCustomer(null, "c1")).toBe(true);
    expect(canSeeCustomer(["c1"], "c1")).toBe(true);
    expect(canSeeCustomer(["c1"], "c2")).toBe(false);
    expect(canSeeCustomer(["c1"], null)).toBe(true);
  });

  it("lets admin see every record and engineers only their own", () => {
    const admin = accessFromRole({
      code: "admin",
      name: "管理员",
      builtin: true,
      dataScope: "all",
      permissions: ALL_PERM_KEYS,
    });
    const engineer = accessFromRole({
      code: "engineer",
      name: "售后工程师",
      builtin: true,
      dataScope: "assigned",
      permissions: ["records.view"],
    });
    expect(canSeeRecord(admin, "u1", "u2")).toBe(true);
    expect(canSeeRecord(admin, "u1", null)).toBe(true);
    expect(canSeeRecord(engineer, "u1", "u1")).toBe(true);
    expect(canSeeRecord(engineer, "u1", "u2")).toBe(false);
    expect(canSeeRecord(engineer, "u1", null)).toBe(false);
  });
});
