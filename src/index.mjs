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
      primary_group: "mprw-simfra",
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

//check if value is primitive
function isPrimitive(obj) {
  return obj !== Object(obj);
}
function deepEqual(obj1, obj2) {
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

function diffProperties(obj1, obj2) {
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
    throw new Error(
      `user and password lists don't match up! users: ${Object.keys(users)}, passwords: ${Object.keys(passwords)}`
    );
  }

  console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(groups).length} groups`);
  //console.log('passwords', passwords)
  //console.log('groups', groups)
  const usersWithoutPasswords = Object.entries(passwords)
    .filter(([u, p]) => !p)
    .map(([u, p]) => u);
  if (usersWithoutPasswords.length > 0) {
    console.log("WARNING: found users without passwords. This allows impersonation without sudo.", usersWithoutPasswords);
  }

  const configGroups = config.groups.reduce((out, g) => {
    out[g.groupname] = g;
    return out;
  }, {});

  const configUserToUpdatePassword = config.users.reduce((out, u) => {
    out[u.username] = u.update_password;
    return out;
  }, {});

  const configPasswords = config.users.reduce((out, u) => {
    out[u.username] = u.password;
    return out;
  }, {});

  const configUsers = config.users.reduce((out, u) => {
    const { additional_groups, password, update_password, ...rest } = u;
    out[u.username] = {
      ...rest,
      additional_groups: additional_groups.sort(),
    };
    return out;
  }, {});

  const newGroups = Object.keys(configGroups).filter((g) => !(g in groups));
  const groupsToDelete = Object.keys(groups).filter(
    (g) =>
      !(g in configGroups) &&
      config.managed_gid_range[0] <= groups[g].gid &&
      groups[g].gid <= config.managed_gid_range[1]
  );
  const groupPropertyDiff = Object.keys(configGroups)
    .filter((g) => g in groups)
    .map((g) => {
      const { users, ...existingGroup } = groups[g];
      return [g, diffProperties(configGroups[g], existingGroup)];
    })
    .filter(([g, diff]) => diff.size > 0);
  const groupModArgs = groupPropertyDiff.map(([g, diff]) => {
    const args = [];

    if (diff.has("gid")) {
      throw new Error(
        `Group ${g} has a different GID in the config (${configGroups[g].gid}) than on the system (${groups[g].gid}). This is not supported. Please delete the group and re-create it with the desired GID.`
      );
    }

    if (diff.size > 0) {
      throw new Error(`Missing update functions for the following group properties: ${diff.join(", ")}`);
    }

    args.push(g);

    return args;
  });

  const newUsers = Object.keys(configUsers).filter((u) => !(u in users));
  const usersToDelete = Object.keys(users).filter(
    (u) =>
      !(u in configUsers) && config.managed_uid_range[0] <= users[u].uid && users[u].uid <= config.managed_uid_range[1]
  );
  const userPropertyDiff = Object.keys(configUsers)
    .filter((u) => !(u in newUsers))
    .map((u) => [u, diffProperties(configUsers[u], users[u])])
    .filter(([u, diff]) => diff.size > 0);
  const userModArgs = userPropertyDiff.map(([u, diff]) => {
    const args = [];

    if (diff.has("uid")) {
      throw new Error(
        `User ${u} has a different UID in the config (${configUsers[u].uid}) than on the system (${users[u].uid}). This is not supported. Please delete the user and re-create it with the desired UID.`
      );
    }

    if (diff.has("primary_group")) {
      if (!(configUsers[u].primary_group in configGroups)) {
        throw new Error(`User ${u} has a primary group ${configUsers[u].primary_group} that is not in the config`);
      }
      args.push("--gid", configGroups[configUsers[u].primary_group].gid);
      diff.delete("primary_group");
    }

    if (diff.has("additional_groups")) {
      args.push("--groups", configUsers[u].additional_groups.join(","));
      diff.delete("additional_groups");
    }

    if (diff.has("shell")) {
      args.push("--shell", configUsers[u].shell);
      diff.delete("shell");
    }

    if (diff.size > 0) {
      throw new Error(`Missing update functions for the following user properties: ${[...diff].join(", ")}`);
    }

    args.push(u);

    return args;
  });
  console.log("usersToDelete", usersToDelete);
  console.log("groupsToDelete", groupsToDelete);
  console.log("newGroups", newGroups);
  console.log("newUsers", newUsers);

  console.log("groupModArgs", groupModArgs);
  console.log("userModArgs", userModArgs);

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
