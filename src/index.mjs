#!/usr/bin/env zx

// TODO: find out how to package this: https://dev.to/zauni/create-a-zx-nodejs-script-as-binary-with-pkg-5abf
import { readFile } from "node:fs/promises";
import { validateConfig, getExistingDirectory, getConfiguredDirectory, diffProperties, deepEqual } from "./utils.mjs";

// TODO: make this a proper CLI
if (process.argv.length !== 4) {
  console.error("Usage: $0 <config.json>");
  process.exit(1);
}
const configPath = process.argv[3];
const config = JSON.parse(await readFile(configPath, { encoding: "utf8" }));

if (!validateConfig(config)) {
  console.error("Invalid config:", validateConfig.errors);
  process.exit(1);
}

async function getSSHKeys(usernames, base_dir) {
  const sshKeyFiles = await Promise.all(
    usernames.map(async (u) => {
      const authorizedKeysPath = `${base_dir}/${u}/.ssh/authorized_keys`;
      const authorizedKeys = await readFile(authorizedKeysPath, { encoding: "utf8" }).catch((e) => "");
      return [u, authorizedKeys.split("\n").filter((l) => l)];
    })
  );

  return Object.fromEntries(sshKeyFiles);
}

const { users, passwords, groups } = await getExistingDirectory();

console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(groups).length} groups`);
//console.log('passwords', passwords)
//console.log('groups', groups)
const usersWithoutPasswords = Object.entries(passwords)
  .filter(([u, p]) => !p)
  .map(([u, p]) => u);
if (usersWithoutPasswords.length > 0) {
  console.log("WARNING: found users without passwords. This allows impersonation without sudo.", usersWithoutPasswords);
}

const sshKeys = await getSSHKeys(Object.keys(users), config.user_ssh_key_base_dir);

const { configGroups, configUsers, configPasswords, configSSHKeys, configUpdatePassword } = getConfiguredDirectory(config);

const newGroups = Object.keys(configGroups).filter((g) => !(g in groups));
const groupsToDelete = Object.keys(groups).filter(
  (g) => !(g in configGroups) && config.managed_gid_range[0] <= groups[g].gid && groups[g].gid <= config.managed_gid_range[1]
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

  if (diff.delete("gid")) {
    throw new Error(
      `Group ${g} has a different GID in the config (${configGroups[g].gid}) than on the system (${groups[g].gid}).` +
        ` This is not supported. Please delete the group and re-create it with the desired GID.`
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
  (u) => !(u in configUsers) && config.managed_uid_range[0] <= users[u].uid && users[u].uid <= config.managed_uid_range[1]
);
const userPropertyDiff = Object.keys(configUsers)
  .filter((u) => !(u in newUsers))
  .map((u) => [u, diffProperties(configUsers[u], users[u])])
  .filter(([u, diff]) => diff.size > 0);
const userModArgs = userPropertyDiff.map(([u, diff]) => {
  const args = [];

  if (diff.delete("uid")) {
    throw new Error(
      `User ${u} has a different UID in the config (${configUsers[u].uid}) than on the system (${users[u].uid}).` +
        ` This is not supported. Please delete the user and re-create it with the desired UID.`
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

const requiresSSHKeyUpdate = Object.keys(configSSHKeys).filter((u) => !(u in newUsers) && !deepEqual(sshKeys[u], configSSHKeys[u]));

console.log("usersToDelete", usersToDelete);
console.log("groupsToDelete", groupsToDelete);
console.log("newGroups", newGroups);
console.log("newUsers", newUsers);

console.log("groupModArgs", groupModArgs);
console.log("userModArgs", userModArgs);
console.log("requiresSSHKeyUpdate", requiresSSHKeyUpdate);

const passwordsToSet = Object.keys(configPasswords).filter(
  (u) => configPasswords[u] !== passwords[u] && (u in newUsers || configUpdatePassword[u] === "always")
);

// TODO: Execute the following sequence:
// Delete users
// Delete groups
// Create groups
// Create users
// Set passwords
// Populate SSH keys

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
