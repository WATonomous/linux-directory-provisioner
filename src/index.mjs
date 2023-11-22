#!/usr/bin/env zx

import Ajv from "ajv";
// TODO: find out how to package this: https://dev.to/zauni/create-a-zx-nodejs-script-as-binary-with-pkg-5abf
import { readFile } from "node:fs/promises";
const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });

// To access /etc/shadow:
// sudo usermod --append --groups shadow ben
// newgrp shadow

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
    // TODO: add SSH keys
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
  },
  required: ["users", "groups"],
  additionalProperties: false,
};

const validateConfig = ajv.compile(configSchema);

const config = {
  managed_uid_range: [1500, 3000],
  managed_gid_range: [1200, 3000],
  users: [
    {
      username: "rainbowunicornwatocluster",
      password: "$1$PCSqGwKq$rLcYcRDkg3jHPPs3N.gW6.",
      update_password: "always",
      uid: 1705,
      primary_group: "rainbowunicornwatocluster",
      additional_groups: ["planning-research", "mprw-simfra"],
      shell: "/bin/bash",
    },
  ],
  groups: [
    {
      groupname: "planning-research",
      gid: 1200,
    },
    {
      groupname: "mprw-simfra",
      gid: 1201,
    },
  ],
};

if (!validateConfig(config)) {
  console.error(validateConfig.errors);
  process.exit(1);
}

console.log(config);

function deepEqual(obj1, obj2) {
  // Compare objects deeply, ignoring top-level key order
  return JSON.stringify(obj1, Object.keys(obj1).sort()) === JSON.stringify(obj2, Object.keys(obj2).sort());
}

function diffProperties(obj1, obj2) {
  const obj1Keys = Object.keys(obj1).sort();
  const obj2Keys = Object.keys(obj2).sort();

  if (!deepEqual(obj1Keys, obj2Keys)) {
    throw new Error(`Object keys don't match: ${obj1Keys} vs ${obj2Keys}`);
  }

  const out = [];
  for (const k of obj1Keys) {
    if (!deepEqual(obj1[k], obj2[k])) {
      out.push(k);
    }
  }

  return out;
}

void (async function () {
  //const promises = await import('node:fs/promises');
  //console.log('promises', promises);
  //const readFile = promises.readFile;

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
      users: t[3] ? t[3].split(",").toSorted() : [],
    }))
    .reduce((out, g) => {
      out[g.groupname] = g;
      return out;
    }, {});

  const gidToGroupName = Object.values(groups).reduce((out, g) => {
    out[g.gid] = g.groupname;
    return out;
  });

  const users = userLines
    .map((l) => l.split(":"))
    .map((t) => ({
      username: t[0],
      uid: Number(t[2]),
      primary_group: gidToGroupName[Number(t[3])],
      shell: t[6],
    }))
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
    throw new Error(
      `user and password lists don't match up! users: ${Object.keys(users)}, passwords: ${Object.keys(passwords)}`
    );
  }

  console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(groups).length} groups`);
  //console.log('passwords', passwords)
  //console.log('groups', groups)
  //console.log('users without passwords', Object.values(passwords).filter(p=>!p.password))
  console.log(
    "groups that don't belong to users:",
    Object.keys(groups).filter((g) => !(g in users))
  );

  const configGroupToUsers = config.users.reduce((out, u) => {
    for (const g of [u.primary_group, ...u.additional_groups]) {
      if (!(g in out)) out[g] = [];
      out[g].push(u.username);
    }
  });

  const configGroups = config.groups.reduce((out, g) => {
    out[g.groupname] = {
      ...g,
      users: configGroupToUsers[g.groupname]?.toSorted() ?? [],
    };
    return out;
  });

  const configUserToUpdatePassword = config.users.reduce((out, u) => {
    out[u.username] = u.update_password;
    return out;
  });

  const configPasswords = config.users.reduce((out, u) => {
    out[u.username] = u.password;
    return out;
  });

  const configUsers = config.users.reduce((out, u) => {
    const { additional_groups, password, update_password, ...rest } = u;
    out[u.username] = rest;
    return out;
  });

  const newGroups = Object.keys(configGroups).filter((g) => !(g in groups));
  const groupsToDelete = Object.keys(groups).filter(
    (g) =>
      !(g in configGroups) &&
      config.managed_gid_range[0] <= groups[g].gid &&
      groups[g].gid <= config.managed_gid_range[1]
  );
  const groupPropertyDiff = Object.keys(configGroups)
    .filter((g) => g in groups)
    .map((g) => [g, diffProperties(configGroups[g], groups[g])])
    .filter(([g, diffProperties]) => diffProperties.length > 0);
  const groupModArgs = groupPropertyDiff.map(([g, diffProperties]) => {
    const args = [];

    if ("gid" in diffProperties) {
      throw new Error(
        `Group ${g} has a different GID in the config (${configGroups[g].gid}) than on the system (${groups[g].gid}). This is not supported. Please delete the group and re-create it with the desired GID.`
      );
    }

    // TODO: groupmod does not have a --users option in shadow-utils that comes with Ubuntu 22.04.
    // So we need to change the code to set groups in usermod instead.
    // https://unix.stackexchange.com/a/713184/118161

    if (diffProperties.length > 0) {
      throw new Error(`Missing update functions for the following group properties: ${diffProperties.join(", ")}`);
    }

    return args;
  });

  const newUsers = Object.keys(configUsers).filter((u) => !(u in users));
  const usersToDelete = Object.keys(users).filter(
    (u) =>
      !(u in configUsers) && config.managed_uid_range[0] <= users[u].uid && users[u].uid <= config.managed_uid_range[1]
  );
  const userPropertyDiff = Object.keys(configUsers)
    .filter((u) => u in users)
    .map((u) => [u, diffProperties(configUsers[u], users[u])])
    .filter(([u, diffProperties]) => diff.length > 0);
  const userModArgs = userPropertyDiff.map(([u, diffProperties]) => {
    const args = [];

    if ("uid" in diffProperties) {
      throw new Error(
        `User ${u} has a different UID in the config (${configUsers[u].uid}) than on the system (${users[u].uid}). This is not supported. Please delete the user and re-create it with the desired UID.`
      );
    }

    if ("primary_group" in diffProperties) {
      if (!(configUsers[u].primary_group in configGroups)) {
        throw new Error(`User ${u} has a primary group ${configUsers[u].primary_group} that is not in the config`);
      }
      args.push("--gid", configGroups[configUsers[u].primary_group].gid);
      delete diffProperties["primary_group"];
    }

    if ("shell" in diffProperties) {
      args.push("--shell", configUsers[u].shell);
      delete diffProperties["shell"];
    }

    if (diffProperties.length > 0) {
      throw new Error(`Missing update functions for the following user properties: ${diffProperties.join(", ")}`);
    }

    return args;
  });

  const passwordsToSet = Object.keys(configPasswords).filter(
    (u) => configPasswords[u] !== passwords[u] && (u in newUsers || configUserToUpdatePassword[u] === "always")
  );

  // TODO: Execute the following sequence:
  // Delete users
  // Delete groups
  // Create groups
  // Create users
  // Set passwords

  // TODO:
  // - [ ] Disallow UID/GID changes
  // - [ ] dry-run
  // - [ ] filter for managed user/group range
  // - [ ] update_password on_create/always
  //
  // userdel:
  // https://linux.die.net/man/8/userdel
  // userdel --remove <user> # removes home directory
  //
  // groups:
  // https://www.redhat.com/sysadmin/linux-groups
  // groupadd --gid <gid> <group>
  // grouopdel <group>
  //
  // useradd:
  // https://linuxize.com/post/how-to-create-users-in-linux-using-the-useradd-command/
  // useradd --create-home --uid <uid> --gid <gid> --groups [list_if_exists] --shell [shell_if_exists] username
  //
  // usermod:
  // https://www.geeksforgeeks.org/usermod-command-in-linux-with-examples/
  //
  // set encrypted password:
  // https://unixutils.com/manually-generate-and-set-encrypted-password-using-chpasswd/
  // echo 'username:$1$PCSqGwKq$rLcYcRDkg3jHPPs3N.gW6.' | chpasswd -e
  // https://github.com/google/zx/blob/a9b573e026b16da617d99c1605a71c4242bd81eb/examples/interactive.mjs#L20
  // const p = $`chpasswd -e`.stdio('pipe')
  // https://google.github.io/zx/process-promise#stdin
  // p.stdin.write('username:$1$PCSqGwKq$rLcYcRDkg3jHPPs3N.gW6.\n')
  // p.stdin.end()
  //
})();
