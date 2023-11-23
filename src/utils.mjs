import { readFile, readdir } from 'node:fs/promises';

export function parseConfig(config) {
  const configGroups = Object.fromEntries(config.groups.map((g) => [g.groupname, g]));
  const configUpdatePassword = Object.fromEntries(config.users.map((u) => [u.username, u.update_password]));
  const configPasswords = Object.fromEntries(config.users.map((u) => [u.username, u.password]));
  const configSSHKeys = Object.fromEntries(config.users.map((u) => [u.username, u.ssh_authorized_keys]));
  const configLinger = Object.fromEntries(config.users.map((u) => [u.username, u.linger]));

  const configUsers = config.users.reduce((out, u) => {
    const {
      additional_groups,
      password: _password,
      update_password: _update_password,
      ssh_authorized_keys: _ssh_authorized_keys,
      linger: _linger,
      ...rest
    } = u;
    out[u.username] = {
      ...rest,
      additional_groups: additional_groups.sort(),
    };
    return out;
  }, {});

  return {
    configGroups,
    configUsers,
    configPasswords,
    configSSHKeys,
    configUpdatePassword,
    configLinger,
  };
}

export async function getExistingDirectory() {
  // Load current configuration from system
  const [userLines, shadowLines, groupLines, lingerUsernames] = await Promise.all([
    readFile("/etc/passwd", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readFile("/etc/shadow", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readFile("/etc/group", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readdir("/var/lib/systemd/linger/"),
  ]);

  const groups = groupLines
    .map((l) => l.split(':'))
    .map((t) => ({
      groupname: t[0],
      gid: Number(t[2]),
      users: t[3] ? t[3].split(',') : [],
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
    .map((l) => l.split(':'))
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
    .map((l) => l.split(':'))
    .map((t) => ({ username: t[0], password: t[1] }))
    .reduce((out, u) => {
      out[u.username] = u.password;
      return out;
    }, {});

  if (Object.keys(users).length !== Object.keys(passwords).length) {
    throw new Error(`user and password lists don't match up! users: ${Object.keys(users)}, passwords: ${Object.keys(passwords)}`);
  }

  const lingerStates = Object.fromEntries(Object.keys(users).map((u) => [u, lingerUsernames.includes(u)]));

  return { users, passwords, groups, lingerStates };
}

// check if value is primitive
export function isPrimitive(obj) {
  return obj !== Object(obj);
}
export function deepEqual(obj1, obj2) {
  // Derived from https://stackoverflow.com/a/45683145/4527337
  if (obj1 === obj2)
  // it's just the same object. No need to compare.
  { return true; }

  if (isPrimitive(obj1) && isPrimitive(obj2))
  // compare primitives
  { return obj1 === obj2; }

  if (isPrimitive(obj1) || isPrimitive(obj2))
  // one is primitive but the other isn't.
  { return false; }

  if (Object.keys(obj1).length !== Object.keys(obj2).length) return false;

  // compare objects with same number of keys
  for (const key of Object.keys(obj1)) {
    if (!(key in obj2)) return false; // other object doesn't have this prop
    if (!deepEqual(obj1[key], obj2[key])) return false;
  }

  return true;
}

export function diffProperties(obj1, obj2) {
  if (obj1 === undefined || obj2 === undefined) {
    throw new Error(`Can't diff undefined objects: ${JSON.stringify(obj1)} vs ${JSON.stringify(obj2)}`);
  }

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

export async function getSSHKeys(users, baseDir) {
  const sshKeyFiles = await Promise.all(
    users.map(async (u) => {
      const expandedBaseDir = baseDir.replaceAll('%u', u.username).replaceAll('%U', u.uid);
      const authorizedKeysPath = `${expandedBaseDir}/authorized_keys`;
      const authorizedKeys = await readFile(authorizedKeysPath, { encoding: 'utf8' }).catch((_e) => '');
      return [u.username, authorizedKeys.split('\n').filter((l) => l)];
    }),
  );

  return Object.fromEntries(sshKeyFiles);
}