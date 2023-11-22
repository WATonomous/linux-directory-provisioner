import Ajv from "ajv";
import { readFile } from "node:fs/promises";

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });

const userSchema = {
  type: "object",
  properties: {
    username: { type: "string" },
    password: { type: "string" },
    update_password: { enum: ["always", "on_create"] },
    uid: { type: "number" },
    primary_group: { type: "string" },
    additional_groups: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      default: [],
    },
    shell: { type: "string", default: "/bin/bash" },
    ssh_authorized_keys: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["username", "password", "update_password", "uid", "primary_group"],
  additionalProperties: false,
};

const groupSchema = {
  type: "object",
  properties: {
    groupname: { type: "string" },
    gid: { type: "number" },
  },
  required: ["groupname", "gid"],
  additionalProperties: false,
};

const configSchema = {
  type: "object",
  properties: {
    users: { type: "array", items: userSchema },
    groups: { type: "array", items: groupSchema },
    managed_uid_range: {
      type: "array",
      description:
        "Range of UIDs that are managed by this script. Users with UIDs in this range will be deleted if they are not in the config.",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
    managed_gid_range: {
      type: "array",
      description:
        "Range of GIDs that are managed by this script. Groups with GIDs in this range will be deleted if they are not in the config.",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
    user_ssh_key_base_dir: { type: "string", description: "Base directory for user SSH keys.", default: "/home" },
  },
  required: ["users", "groups"],
  additionalProperties: false,
};

export const validateConfig = ajv.compile(configSchema);

export function getConfiguredDirectory(config) {
  const configGroups = Object.fromEntries(config.groups.map((g) => [g.groupname, g]));
  const configUpdatePassword = Object.fromEntries(config.users.map((u) => [u.username, u.update_password]));
  const configPasswords = Object.fromEntries(config.users.map((u) => [u.username, u.password]));
  const configSSHKeys = Object.fromEntries(config.users.map((u) => [u.username, u.ssh_authorized_keys]));

  const configUsers = config.users.reduce((out, u) => {
    const { additional_groups, password, update_password, ssh_authorized_keys, ...rest } = u;
    out[u.username] = {
      ...rest,
      additional_groups: additional_groups.sort(),
    };
    return out;
  }, {});

  return { configGroups, configUsers, configPasswords, configSSHKeys, configUpdatePassword };
}

export async function getExistingDirectory() {
  // Load current configuration from system
  const [userLines, shadowLines, groupLines] = await Promise.all([
    readFile("/etc/passwd", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readFile("/etc/shadow", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readFile("/etc/group", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
  ]);

  const groups = groupLines
    .map((l) => l.split(":"))
    .map((t) => ({
      groupname: t[0],
      gid: Number(t[2]),
      users: t[3] ? t[3].split(",") : [],
    }))
    .reduce((out, g) => {
      out[g.groupname] = g;
      return out;
    }, {});

  const userToGroups = Object.values(groups).reduce((out, g) => {
    for (const u of g.users) {
      if (!(u in out)) out[u] = [];
      out[u].push(g.groupname);
    }
    return out;
  }, {});

  const gidToGroupName = Object.values(groups).reduce((out, g) => {
    out[g.gid] = g.groupname;
    return out;
  }, {});

  const users = userLines
    .map((l) => l.split(":"))
    .map((t) => {
      const username = t[0];
      const uid = Number(t[2]);
      const primary_group = gidToGroupName[Number(t[3])];
      const additional_groups = userToGroups[username]?.filter((g) => g !== primary_group).sort() ?? [];
      const shell = t[6];

      return {
        username,
        uid,
        primary_group,
        additional_groups,
        shell,
      };
    })
    .reduce((out, u) => {
      out[u.username] = u;
      return out;
    }, {});

  const passwords = shadowLines
    .map((l) => l.split(":"))
    .map((t) => ({ username: t[0], password: t[1] }))
    .reduce((out, u) => {
      out[u.username] = u.password;
      return out;
    }, {});

  if (Object.keys(users).length != Object.keys(passwords).length) {
    throw new Error(`user and password lists don't match up! users: ${Object.keys(users)}, passwords: ${Object.keys(passwords)}`);
  }

  return { users, passwords, groups };
}

//check if value is primitive
export function isPrimitive(obj) {
  return obj !== Object(obj);
}
export function deepEqual(obj1, obj2) {
  // Derived from https://stackoverflow.com/a/45683145/4527337
  if (obj1 === obj2)
    // it's just the same object. No need to compare.
    return true;

  if (isPrimitive(obj1) && isPrimitive(obj2))
    // compare primitives
    return obj1 === obj2;

  if (Object.keys(obj1).length !== Object.keys(obj2).length) return false;

  // compare objects with same number of keys
  for (let key in obj1) {
    if (!(key in obj2)) return false; //other object doesn't have this prop
    if (!deepEqual(obj1[key], obj2[key])) return false;
  }

  return true;
}

export function diffProperties(obj1, obj2) {
  const obj1Keys = Object.keys(obj1).sort();
  const obj2Keys = Object.keys(obj2).sort();

  if (!deepEqual(obj1Keys, obj2Keys)) {
    throw new Error(`Object keys don't match: ${obj1Keys} vs ${obj2Keys}`);
  }

  const out = new Set();
  for (const k of obj1Keys) {
    if (!deepEqual(obj1[k], obj2[k])) {
      out.add(k);
    }
  }

  return out;
}
