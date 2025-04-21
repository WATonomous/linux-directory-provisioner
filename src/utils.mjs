import { readFile, readdir, access } from 'node:fs/promises';
import { $ } from 'zx';

export const QUOTA_BLOCK_SIZE = 1024; // bytes

/**
 * Maps over the properties of an object and applies a function to each value.
 * Returns a new object with the transformed values.
 * Derived from: https://stackoverflow.com/a/14810722
 *
 * @param {Object} obj - The object to map over.
 * @param {Function} fn - The function to apply to each value.
 * @returns {Object} - The new object with transformed values.
 *
 * @example
 * const obj = { a: 1, b: 2, c: 3 };
 * const double = (value) => value * 2;
 * const transformedObj = mapObjectValues(obj, double);
 * // transformedObj: { a: 2, b: 4, c: 6 }
 *
 * @example
 * const obj = { name: 'John', age: 30 };
 * const capitalize = (value) => value.toUpperCase();
 * const transformedObj = mapObjectValues(obj, capitalize);
 * // transformedObj: { name: 'JOHN', age: '30' }
 */
export function objectMap(obj, fn) {
  return Object.fromEntries(
    Object.entries(obj).map(
      ([k, v], i) => [k, fn(v, k, i)]
    )
  )
}

// Implementation of Object.groupBy according to https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/groupBy
export function groupBy(arr, fn) {
  return arr.reduce((out, x) => {
    const key = fn(x);
    if (!(key in out)) out[key] = [];
    out[key].push(x);
    return out;
  }, {})
}

// Converts a human-readable size string to a number of bytes
// E.g. "1Ki" -> 1024, "1Mi" -> 1048576, "1Gi" -> 1073741824
export function parseIECSize(s) {
  const match = s.match(/^([0-9]+)([kKmMgGtT])?i?$/);
  if (!match) {
    throw new Error(`Invalid size string: ${s}`);
  }
  const size = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!unit) {
    return size;
  }
  const unitMap = {
    k: 1024,
    m: 1024**2,
    g: 1024**3,
    t: 1024**4,
  };
  return size * unitMap[unit];
}

// Converts a human-readable size string to a number
// E.g. "1K" -> 1000, "1M" -> 1000000, "1G" -> 1000000000
export function parseSISize(s) {
  const match = s.match(/^([0-9]+)([kKmMgGtT])?$/);
  if (!match) {
    throw new Error(`Invalid size string: ${s}`);
  }
  const size = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!unit) {
    return size;
  }
  const unitMap = {
    k: 1000,
    m: 1000**2,
    g: 1000**3,
    t: 1000**4,
  };
  return size * unitMap[unit];
}

export function normalizeDiskQuota(q) {
  return {
    path: q.path,
    bytes_soft_limit: parseIECSize(q.bytes_soft_limit),
    bytes_hard_limit: parseIECSize(q.bytes_hard_limit),
    inodes_soft_limit: parseSISize(q.inodes_soft_limit),
    inodes_hard_limit: parseSISize(q.inodes_hard_limit),
  };
}

export function parseConfig(config) {
  const configGroups = Object.fromEntries(config.groups.map((g) => [g.groupname, g]));
  const configUpdatePassword = Object.fromEntries(config.users.map((u) => [u.username, u.update_password]));
  const configPasswords = Object.fromEntries(config.users.map((u) => [u.username, u.password]));
  const configSSHKeys = Object.fromEntries(config.users.map((u) => [u.username, u.ssh_authorized_keys]));
  const configLinger = Object.fromEntries(config.users.map((u) => [u.username, u.linger]));
  // Object of the form { <path>: { <uid>: { ...quotaConfig } } }
  const configUserDiskQuota = objectMap(
    groupBy(
      config.users.flatMap((u) =>
        u.disk_quota.map(normalizeDiskQuota).map((d) => {
          const { path, ...quotaConfig } = d;
          return [path, u.uid, quotaConfig];
        })
      ),
      // group by path
      (x) => x[0]
    ),
    // convert to object of the form { <uid>: { ...quotaConfig } }
    (v) => Object.fromEntries(v.map((x) => [x[1], x[2]]))
  );
  // XFS disk quota is implemented as a quota on the root user. The root user is not constrained by quotas.
  for (const quota of config.xfs_default_user_quota) {
    const { path, ...quotaConfig } = normalizeDiskQuota(quota);
    if (!(path in configUserDiskQuota)) {
      configUserDiskQuota[path] = {};
    }
    if ('0' in configUserDiskQuota[path]) {
      throw new Error(`The root user (uid 0) already has a configured quota for path ${path}! This is the same as setting the xfs_default_user_quota property.`)
    }
    configUserDiskQuota[path]['0'] = quotaConfig;
  }

  const configUsers = config.users.reduce((out, u) => {
    const {
      additional_groups,
      password: _password,
      update_password: _update_password,
      ssh_authorized_keys: _ssh_authorized_keys,
      linger: _linger,
      disk_quota: _disk_quota,
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
    configUserDiskQuota,
  };
}

export async function isLingerSupported() {
  try {
    await access("/var/lib/systemd/linger");
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false; // Directory does not exist
    }
    throw error; // Rethrow unexpected errors
  }
}

export async function getExistingDirectory() {
  // Load current configuration from system
  const [userLines, shadowLines, groupLines, lingerUsernames] = await Promise.all([
    readFile("/etc/passwd", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readFile("/etc/shadow", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    readFile("/etc/group", { encoding: "utf8" }).then((s) => s.split("\n").filter((l) => l)),
    isLingerSupported().then(supported => supported ? readdir("/var/lib/systemd/linger/") : []),
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

export function makeQuotaConfig(bytes_soft_limit, bytes_hard_limit, inodes_soft_limit, inodes_hard_limit) {
  return {
    bytes_soft_limit,
    bytes_hard_limit,
    inodes_soft_limit,
    inodes_hard_limit,
  };
}

/**
 * Retrieves the disk quota information for a given path.
 * @param {string} path - The path for which to retrieve the disk quota.
 * @returns {Promise<Object>} - A promise that resolves to an object of the form { <uid>: { bytes_soft_limit, bytes_hard_limit, inodes_soft_limit, inodes_hard_limit } }
 */
export async function getUserDiskQuotaForPath(path) {
  // turn off verbosity temporarily
  const zxIsVerbose = $.verbose;
  $.verbose = false;
  // outputs <uid> <block soft> <block hard> <inode soft> <inode hard> where block is in 1KiB units
  const repquotaResult = await $`repquota ${path} --user --no-names --raw-grace | grep '^#' | awk '{print $1,$4,$5,$8,$9}' | cut -c2-`;
  $.verbose = zxIsVerbose;
  const lines = repquotaResult.stdout
    .split("\n")
    .filter((l) => l)
    .map((l) => l.split(" "));

  return Object.fromEntries(lines
    .map((l) => [Number(l[0]), makeQuotaConfig(
      Number(l[1]) * QUOTA_BLOCK_SIZE,
      Number(l[2]) * QUOTA_BLOCK_SIZE,
      Number(l[3]),
      Number(l[4]),
    )])
    // filter out empty quotas
    .filter(([_uid, q]) => q.bytes_soft_limit || q.bytes_hard_limit || q.inodes_soft_limit || q.inodes_hard_limit)
  );
}

/**
 * Retrieves the disk quota for multiple paths.
 * @param {string[]} paths - An array of paths for which to retrieve the disk quota.
 * @returns {Promise<Object>} - A promise that resolves to an object of the form { <path>: { <uid>: { bytes_soft_limit, bytes_hard_limit, inodes_soft_limit, inodes_hard_limit } } }
 */
export async function getDiskQuota(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await getUserDiskQuotaForPath(p)])));
}

export function unique(arr) {
  return [...new Set(arr)];
}