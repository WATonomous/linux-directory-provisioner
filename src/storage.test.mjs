import { validateStorageConfig } from "./schema.mjs";

const roots = ["/mnt/drive/users"];
const row = { path: "/mnt/drive/users/alex", owner: 21001, group: "team", mode: "2775" };

test("accepts explicit storage directories and groups without a users list", () => {
  expect(validateStorageConfig({
    roots,
    groups: [{ groupname: "team", gid: 23001 }],
    directories: [row, { path: "/mnt/drive/users/sam", owner: "root", group: 23001, mode: "750" }],
  })).toBe(true);
});

test("defaults standalone groups and accepts an explicitly empty directory list", () => {
  const config = { roots, directories: [] };
  expect(validateStorageConfig(config)).toBe(true);
  expect(config.groups).toEqual([]);
});

test.each([
  {},
  ...[undefined, [], ["relative"], ["/mnt/\0data"]].map((value) => ({ roots: value, directories: [] })),
  { directories: [], users: [] },
  { directories: [], xfs_default_user_quota: [] },
  { directories: [], groups: [{ groupname: "team", gid: 2.5 }] },
  { directories: [{ ...row, path: "relative/path" }] },
  { directories: [{ ...row, owner: -1 }] },
  { directories: [{ ...row, group: "" }] },
  ...[504, 770, "77", "07770", "2885"].map((mode) => ({ directories: [{ ...row, mode }] })),
  { directories: [{ ...row, mode: undefined }] },
])("rejects invalid storage configs (%j)", (config) => {
  expect(validateStorageConfig({ roots, ...config })).toBe(false);
});
