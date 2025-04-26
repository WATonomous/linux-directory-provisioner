#!/usr/bin/env zx

import './patch.mjs';

import path from "path";
import { $, stdin, argv, question } from "zx";
import { readFile } from "node:fs/promises";
import {
  isLingerSupported,
  getExistingDirectory,
  parseConfig,
  diffProperties,
  deepEqual,
  getSSHKeys,
  getDiskQuota,
  unique,
  objectMap,
  makeQuotaConfig,
  QUOTA_BLOCK_SIZE,
} from "./utils.mjs";
import { validateConfig } from "./schema.mjs";

function printUsageAndExit(exitCode = 0) {
  console.error("Usage: $0 [--help] [--dry-run] [--no-confirm] [--debug] --config=config.json");
  process.exit(exitCode);
}

if (argv.debug) {
  console.log("argv:", argv);
}
if (argv.help) {
  printUsageAndExit(0);
}
if (!argv.config) {
  console.error("Missing required argument --config");
  printUsageAndExit(1);
}

// =====================================================
// Load, validate, and parse config
// =====================================================

console.time("readConfig");
let config;
if (argv.config === "-") {
  console.log("Reading config from stdin...");
  config = await stdin().then(JSON.parse);
} else {
  console.log(`Reading config from ${argv.config}...`);
  config = await readFile(argv.config, "utf8").then(JSON.parse);
}
console.timeLog("readConfig");

console.log("Validating config");
console.time("validateConfig");
if (!validateConfig(config)) {
  console.error("Invalid config:", validateConfig.errors);
  process.exit(1);
}
console.timeLog("validateConfig");

console.log("Parsing config");
console.time("parseConfig");
const {
  configGroups,
  configUsers,
  configPasswords,
  configSSHKeys,
  configUpdatePassword,
  configLinger,
  configUserDiskQuota,
} = parseConfig(config);
console.timeLog("parseConfig");

// =====================================================
// Load existing directory
// =====================================================

console.log("Loading existing directory...");
console.time("getExistingDirectory");
const { users, passwords, groups, lingerStates } = await getExistingDirectory();
console.timeLog("getExistingDirectory");

console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(groups).length} groups`);

const usersWithoutPasswords = Object.entries(passwords).filter(([_u, p]) => !p).map(([u, _p]) => u);
if (usersWithoutPasswords.length > 0) {
  console.warn("WARNING: found users without passwords. This allows impersonation without sudo.", usersWithoutPasswords);
}

console.log("Loading existing SSH keys");
console.time("getSSHKeys");
const sshKeys = await getSSHKeys(Object.values(users), config.user_ssh_key_base_dir);
console.timeLog("getSSHKeys");

const diskQuotaPaths = unique([...config.xfs_default_user_quota.map(q => q.path), ...Object.keys(configUserDiskQuota)]);
console.log(`Loading disk quota for the following path(s): ${diskQuotaPaths.join(", ")}`);
console.time("getDiskQuota");
const diskQuota = await getDiskQuota(diskQuotaPaths);
console.timeLog("getDiskQuota");

// =====================================================
// Calculate changes
// =====================================================

console.log("Calculating changes");
console.time("calculateChanges");
const newGroups = Object.keys(configGroups).filter((g) => !(g in groups));
const newUsers = Object.keys(configUsers).filter((u) => !(u in users));
const usersToDelete = Object.keys(users).filter(
  // Delete users that satisfies all of the following:
  // - within the managed UID range
  // - not in the config
  (u) => !(u in configUsers) && config.managed_uid_range[0] <= users[u].uid && users[u].uid <= config.managed_uid_range[1]
);
const groupsToDelete = Object.keys(groups).filter(
  // Delete groups that satisfies all of the following:
  // - within the managed GID range
  // - not in the config
  // - not a user group that is already going to be deleted by userdel
  (g) =>
    !(g in configGroups) &&
    !usersToDelete.includes(g) &&
    config.managed_gid_range[0] <= groups[g].gid &&
    groups[g].gid <= config.managed_gid_range[1]
);
const groupPropertyDiff = Object.keys(configGroups)
  .filter((g) => g in groups)
  .map((g) => {
    const { users: _users, ...existingGroup } = groups[g];
    return [g, diffProperties(configGroups[g], existingGroup)];
  })
  .filter(([_g, diff]) => diff.size > 0);
const groupModArgs = groupPropertyDiff.map(([g, diff]) => {
  const args = [];

  if (diff.delete("gid")) {
    throw new Error(
      `Group ${g} has a different GID in the config (${configGroups[g].gid}) than on the system (${groups[g].gid}).` +
        " This is not supported. Please delete the group and re-create it with the desired GID."
    );
  }

  if (diff.size > 0) {
    throw new Error(`Missing update functions for the following group properties: ${diff.join(", ")}`);
  }

  args.push(g);

  return args;
});
const userPropertyDiff = Object.keys(configUsers)
  .filter((u) => !newUsers.includes(u))
  .map((u) => [u, diffProperties(configUsers[u], users[u])])
  .filter(([_u, diff]) => diff.size > 0);
const usermodArgs = userPropertyDiff.map(([u, diff]) => {
  const args = [];

  if (diff.delete("uid")) {
    throw new Error(
      `User ${u} has a different UID in the config (${configUsers[u].uid}) than on the system (${users[u].uid}).` +
        " This is not supported. Please delete the user and re-create it with the desired UID."
    );
  }

  if (diff.delete("primary_group")) {
    if (!(configUsers[u].primary_group in configGroups)) {
      throw new Error(`User ${u} has a primary group ${configUsers[u].primary_group} that is not in the config`);
    }
    args.push("--gid", configGroups[configUsers[u].primary_group].gid);
  }

  if (diff.delete("additional_groups")) {
    args.push("--groups", configUsers[u].additional_groups.join(","));
  }

  if (diff.delete("shell")) {
    args.push("--shell", configUsers[u].shell);
  }

  if (diff.size > 0) {
    throw new Error(`Missing update functions for the following user properties: ${[...diff].join(", ")}`);
  }

  args.push(u);

  return args;
});

const requirePasswordUpdate = Object.keys(configPasswords).filter(
  (u) => configPasswords[u] !== passwords[u] && (newUsers.includes(u) || configUpdatePassword[u] === "always")
);
const requireSSHKeyUpdate = Object.keys(configSSHKeys).filter((u) => newUsers.includes(u) || !deepEqual(sshKeys[u], configSSHKeys[u]));
const requireLingerUpdate = Object.keys(configLinger).filter((u) => newUsers.includes(u) || lingerStates[u] !== configLinger[u]);
const diskQuotaChanges = Object.fromEntries(
  diskQuotaPaths.map((p) => {
    const existing = diskQuota[p];
    const quotaConfig = configUserDiskQuota[p];

    const newQuotas = [];
    const updateQuotas = [];
    const deleteQuotas = [];

    for (const [uid, quota] of Object.entries(quotaConfig)) {
      if (uid in existing) {
        if (!deepEqual(existing[uid], quota)) {
          updateQuotas.push([uid, quota]);
        }
      } else {
        newQuotas.push([uid, quota]);
      }
    }

    for (const uid of Object.keys(existing)) {
      if (config.managed_uid_range[0] > uid || uid > config.managed_uid_range[1]) {
        continue;
      }
      if (!(uid in quotaConfig)) {
        deleteQuotas.push([uid, makeQuotaConfig(0,0,0,0)]);
      }
    }

    return [p, { newQuotas, updateQuotas, deleteQuotas }];
  })
)
console.timeLog("calculateChanges");

// Print changes
console.log("usersToDelete", usersToDelete);
console.log("groupsToDelete", groupsToDelete);
console.log("newGroups", newGroups);
console.log("newUsers", newUsers);

console.log("groupModArgs", groupModArgs);
console.log("usermodArgs", usermodArgs);
console.log("requiresSSHKeyUpdate", requireSSHKeyUpdate);
console.log("requiresPasswordUpdate", requirePasswordUpdate);
console.log("requireLingerUpdate", requireLingerUpdate);

console.log("Disk quota changes",
  objectMap(diskQuotaChanges, quotas =>
    objectMap(quotas, q => q.map(([uid, quota]) => `${uid}: ${JSON.stringify(quota)}`))
  )
);

if (argv["dry-run"]) {
  console.log("Dry run. exiting");
  process.exit(0);
}

if (argv.confirm !== false) {
  // Ask for confirmation
  const confirmation = await question("Are you sure you want to apply these changes? [y/N] ");
  if (confirmation !== "y") {
    console.log("Aborting");
    process.exit(1);
  }
}

// Apply changes
console.log(`Deleting ${usersToDelete.length} users...`);
console.time("userdel")
// delete users
for (const u of usersToDelete) {
  await $`userdel --remove ${u}`;
}
// delete SSH keys
await Promise.all(
  usersToDelete.map(async (u) => {
    const username = u;
    const {uid} = users[username];
    const expandedBaseDir = config.user_ssh_key_base_dir.replaceAll("%u", username).replaceAll("%U", uid);
    await $`rm -rf ${expandedBaseDir}`;
  })
);
// delete managed dirs
await Promise.all(
  usersToDelete.map(async (u) => Promise.all(
      config.managed_user_directories.map(async (d) => {
        const formatdir = d.replace("%u", users[u].username).replace("%U", users[u].uid);
        await $`rm -rf ${formatdir}`;
      })
    )
  )
)

console.timeLog("userdel")

console.log(`Deleting ${groupsToDelete.length} groups...`);
console.time("groupdel")
for (const g of groupsToDelete) {
  await $`groupdel ${g}`;
}
console.timeLog("groupdel")

console.log(`Creating ${newGroups.length} groups...`);
console.time("groupadd")
for (const g of newGroups) {
  await $`groupadd --gid ${configGroups[g].gid} ${g}`;
}
console.timeLog("groupadd")

console.log(`Updating group properties for ${groupModArgs.length} groups...`);
console.time("groupmod")
for (const args of groupModArgs) {
  await $`groupmod ${args}`;
}
console.timeLog("groupmod")

console.log(`Creating ${newUsers.length} users...`);
console.time("useradd")
for (const u of newUsers) {
  const args = [
    "--create-home",
    "--uid",
    configUsers[u].uid,
    "--gid",
    configGroups[configUsers[u].primary_group].gid,
    "--shell",
    configUsers[u].shell,
  ];

  if (configUsers[u].additional_groups.length > 0) {
    args.push("--groups", configUsers[u].additional_groups.join(","));
  }

  await $`useradd ${args} ${u}`;
}
// create dirs for new users
await Promise.all(
  newUsers.map(async (u) => Promise.all(
    config.managed_user_directories.map(async (d) => {
      const formatdir = d.replace("%u", users[u].username).replace("%U", users[u].uid);
      await $`mkdir -p ${formatdir}`;
    })
  ))
)
console.timeLog("useradd")

console.log(`Updating user properties for ${usermodArgs.length} users...`);
console.time("usermod")
for (const args of usermodArgs) {
  await $`usermod ${args}`;
}
console.timeLog("usermod")

console.log(`Updating passwords for ${requirePasswordUpdate.length} users...`);
console.time("chpasswd")
if (requirePasswordUpdate.length > 0) {
  const p = $`chpasswd -e`.stdio("pipe");
  for (const username of requirePasswordUpdate) {
    p.stdin.write(`${username}:${configPasswords[username]}\n`);
  }
  p.stdin.end();
}
console.timeLog("chpasswd")

console.log(`Updating SSH keys for ${requireSSHKeyUpdate.length} users...`);
console.time("sshkeys")
// sshKeyCommonDir is the part of the path that is the same for all users
const sshKeyCommonDir = config.user_ssh_key_base_dir.substring(0, config.user_ssh_key_base_dir.indexOf("%"));
await Promise.all(
  requireSSHKeyUpdate.map(async (username) => {
    const expandedBaseDir = config.user_ssh_key_base_dir.replaceAll("%u", username).replaceAll("%U", configUsers[username].uid);
    // userDir is the first directory in the path that is different for each user
    const userDir = path.relative(sshKeyCommonDir, expandedBaseDir).split(path.sep)[0];

    const authorizedKeysPath = `${expandedBaseDir}/authorized_keys`;
    await $`mkdir -p ${expandedBaseDir}`;
    await $`touch ${authorizedKeysPath}`;

    // Set the group ownership of everything in the user directory to the user's primary group
    if (config.use_strict_ssh_key_dir_permissions) {
      await $`chown -R :${configUsers[username].primary_group} ${path.join(sshKeyCommonDir, userDir)}`;
    }

    // Write the SSH keys
    await $`echo ${configSSHKeys[username].join("\n")} > ${authorizedKeysPath}`;
  })
);
if (config.use_strict_ssh_key_dir_permissions) {
  // Set the proper permissions on the directory
  await $`chown -R $(id -u) ${sshKeyCommonDir}`; // Set the owner to the provisioning user (usually root), leave the group as-is
  await $`chmod 755 ${sshKeyCommonDir}`; // all users can read and execute the directory
  await $`chmod -R 750 ${sshKeyCommonDir}/*`; // only the group can read and execute
}
console.timeLog("sshkeys")

if (await isLingerSupported()) {
  console.log(`Updating linger state for ${requireLingerUpdate.length} users...`);
  console.time("linger")
  for (const username of requireLingerUpdate) {
    if (configLinger[username]) {
      await $`loginctl enable-linger ${username}`;
    } else {
      await $`loginctl disable-linger ${username}`;
    }
  }
  console.timeLog("linger")
} else {
  console.log("Linger is not supported on this system. Skipping linger updates.")
}

console.log(`Updating disk quotas for ${Object.keys(diskQuotaChanges).length} path(s)...`);
console.time("diskquota")
for (const [p, quotas] of Object.entries(diskQuotaChanges)) {
  const pipe = $`setquota -b ${p}`.stdio("pipe");
  for (const [uid, quota] of Object.values(quotas).flat()) {
    pipe.stdin.write(`${uid} ${Math.floor(quota.bytes_soft_limit / QUOTA_BLOCK_SIZE)} ${Math.floor(quota.bytes_hard_limit / QUOTA_BLOCK_SIZE)} ${quota.inodes_soft_limit} ${quota.inodes_hard_limit}\n`);
  }
  pipe.stdin.end();
}
console.timeLog("diskquota")
