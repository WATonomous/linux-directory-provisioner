#!/usr/bin/env zx

import { readFile } from "node:fs/promises";
import { getExistingDirectory, parseConfig, diffProperties, deepEqual, getSSHKeys } from "./utils.mjs";
import { validateConfig } from "./schema.mjs";
import { $, stdin, argv, question } from "zx";

if (argv._.length !== 1) {
  console.error("Usage: $0 <config.json>");
  process.exit(1);
}
const configPath = argv._[0];

console.time("readConfig");
let rawConfig;
if (configPath === "-") {
  console.log("Reading config from stdin...");
  rawConfig = await stdin();
} else {
  console.log(`Reading config from ${configPath}...`);
  rawConfig = await readFile(configPath, { encoding: "utf8" });
}
const config = JSON.parse(rawConfig);
console.timeLog("readConfig");

console.log("Validating config");
console.time("validateConfig");
if (!validateConfig(config)) {
  console.error("Invalid config:", validateConfig.errors);
  process.exit(1);
}
console.timeLog("validateConfig");

console.log("Loading existing directory...");
console.time("getExistingDirectory");
const { users, passwords, groups } = await getExistingDirectory();
console.timeLog("getExistingDirectory");

console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(groups).length} groups`);

const usersWithoutPasswords = Object.entries(passwords).filter(([_u, p]) => !p).map(([u, _p]) => u);
if (usersWithoutPasswords.length > 0) {
  console.warn("WARNING: found users without passwords. This allows impersonation without sudo.", usersWithoutPasswords);
}

console.log("Loading existing SSH keys");
console.time("getSSHKeys");
const sshKeys = await getSSHKeys(Object.keys(users), config.user_ssh_key_base_dir);
console.timeLog("getSSHKeys");

console.log("Parsing config");
console.time("parseConfig");
const { configGroups, configUsers, configPasswords, configSSHKeys, configUpdatePassword } = parseConfig(config);
console.timeLog("parseConfig");

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
await Promise.all(
  usersToDelete.map(async (u) => {
    await $`userdel --remove ${u}`;
    await $`rm -rf ${config.user_ssh_key_base_dir}/${u}`;
  })
);
console.timeLog("userdel")

console.log(`Deleting ${groupsToDelete.length} groups...`);
console.time("groupdel")
await Promise.all(groupsToDelete.map((g) => $`groupdel ${g}`));
console.timeLog("groupdel")

console.log(`Creating ${newGroups.length} groups...`);
console.time("groupadd")
await Promise.all(newGroups.map((g) => $`groupadd --gid ${configGroups[g].gid} ${g}`));
console.timeLog("groupadd")

console.log(`Updating group properties for ${groupModArgs.length} groups...`);
console.time("groupmod")
await Promise.all(groupModArgs.map((args) => $`groupmod ${args}`));
console.timeLog("groupmod")

console.log(`Creating ${newUsers.length} users...`);
console.time("useradd")
await Promise.all(
  newUsers.map((u) => {
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

    return $`useradd ${args} ${u}`;
  })
);
console.timeLog("useradd")

console.log(`Updating user properties for ${usermodArgs.length} users...`);
console.time("usermod")
await Promise.all(usermodArgs.map((args) => $`usermod ${args}`));
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
await Promise.all(
  requireSSHKeyUpdate.map(async (username) => {
    const userDir = `${config.user_ssh_key_base_dir}/${username}`;
    const sshDir = `${userDir}/.ssh`;
    const authorizedKeysPath = `${sshDir}/authorized_keys`;
    await $`mkdir -p ${sshDir}`;
    await $`chmod 700 ${userDir}`;
    await $`chmod 700 ${sshDir}`;
    await $`touch ${authorizedKeysPath}`;
    await $`chown -R ${username}:${configUsers[username].primary_group} ${userDir}`;
    await $`echo ${configSSHKeys[username].join("\n")} > ${authorizedKeysPath}`;
  })
);
console.timeLog("sshkeys")
