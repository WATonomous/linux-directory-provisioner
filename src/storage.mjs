import { execFile, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { question } from "zx";

const exec = promisify(execFile);
const stateDirectory = "/var/lib/linux-directory-provisioner";
// eslint-disable-next-line no-bitwise
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

async function openDirectory(path, create = false) {
  let directory = await open("/", directoryFlags);
  try {
    const components = path.slice(1).split("/").filter(Boolean);
    for (const [index, component] of components.entries()) {
      // Anchor each lookup to the opened parent so a symlink swap cannot redirect it.
      const childPath = `/proc/self/fd/${directory.fd}/${component}`;
      let child;
      try {
        child = await open(childPath, directoryFlags);
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Cannot open storage directory ${path}`, { cause: error });
        if (!create) return null;
        const isParent = index < components.length - 1;
        await mkdir(childPath, { mode: isParent ? 0o755 : 0o700 });
        child = await open(childPath, directoryFlags);
        if (isParent) {
          try {
            await child.chown(0, 0);
            await child.chmod(0o755);
          } catch (parentError) {
            await child.close();
            throw parentError;
          }
        }
      }
      await directory.close();
      directory = child;
    }
    const result = directory;
    directory = null;
    return result;
  } finally {
    await directory?.close();
  }
}

async function directoryStat(path) {
  const directory = await openDirectory(path);
  try {
    return await directory?.stat();
  } finally {
    await directory?.close();
  }
}

async function lookupId(database, key) {
  try {
    const { stdout } = await exec("getent", ["--", database, String(key)]);
    return Number(stdout.split(":")[2]);
  } catch (error) {
    if (error.code !== 2) throw error;
    return undefined;
  }
}

async function resolveId(database, value, knownIds) {
  if (/^\d+$/.test(String(value))) {
    const id = Number(value);
    if (id > 4294967294) throw new Error(`Invalid ${database} ID: ${value}`);
    return id;
  }
  if (!knownIds.has(value)) knownIds.set(value, await lookupId(database, value));
  const id = knownIds.get(value);
  if (id === undefined) throw new Error(`Unknown ${database} name: ${value}`);
  return id;
}

async function planStorage(config) {
  const desired = new Set();
  const groups = new Map();
  const owners = new Map();
  const newGroups = [];
  const newGids = new Set();
  const directories = [];

  for (const { groupname, gid } of config.groups) {
    if (groups.has(groupname)) throw new Error(`Duplicate storage group: ${groupname}`);
    const existing = await lookupId("group", groupname);
    groups.set(groupname, gid);
    if (existing !== undefined) {
      if (existing !== gid) throw new Error(`Storage group ${groupname} has GID ${existing}, expected ${gid}`);
      continue;
    }
    if (newGids.has(gid) || await lookupId("group", gid) !== undefined) {
      throw new Error(`GID ${gid} for storage group ${groupname} is already in use`);
    }
    newGroups.push({ groupname, gid });
    newGids.add(gid);
  }

  for (const row of config.directories) {
    const path = resolve(row.path);
    if (path === stateDirectory || path.startsWith(`${stateDirectory}/`) || stateDirectory.startsWith(`${path}/`) || path === "/") {
      throw new Error(`Invalid storage directory: ${row.path}`);
    }
    if (desired.has(path)) throw new Error(`Duplicate storage directory: ${path}`);
    desired.add(path);
    const mode = parseInt(row.mode, 8);

    const uid = await resolveId("passwd", row.owner, owners);
    const gid = await resolveId("group", row.group, groups);
    const stat = await directoryStat(path);
    // eslint-disable-next-line no-bitwise
    if (!stat || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode) {
      directories.push({ path, uid, gid, mode, create: !stat });
    }
  }

  return { newGroups, directories };
}

function summary(plan, planned) {
  const changes = [
    ["Groups to create", "Created groups", plan.newGroups.map(({ groupname }) => groupname)],
    ["Directories to create", "Created directories", plan.directories.filter(({ create }) => create).map(({ path }) => path)],
    ["Directories to update", "Updated directories", plan.directories.filter(({ create }) => !create).map(({ path }) => path)],
  ];
  return changes.filter(([, , items]) => items.length).map(([future, past, items]) => (
    `${planned ? future : past} ${JSON.stringify(items)}`
  ));
}

async function printSummary(lines) {
  await new Promise((done) => { process.stdout.write(`${lines.join("\n")}\n`, done); });
}

async function applyStorage({ newGroups, directories }) {
  process.umask(0o022);
  for (const { groupname, gid } of newGroups) {
    await exec("groupadd", ["--gid", String(gid), "--", groupname]);
  }

  for (const { path, uid, gid, mode } of directories) {
    const directory = await openDirectory(path, true);
    try {
      const stat = await directory.stat();
      if (stat.uid !== uid || stat.gid !== gid) await directory.chown(uid, gid);
      await directory.chmod(mode);
    } finally {
      await directory.close();
    }
  }
}

export default async function provisionStorage(config, argv) {
  let preview;
  if (argv["dry-run"] || argv.confirm !== false) {
    preview = await planStorage(config);
    const lines = summary(preview, true);
    await printSummary(lines.length ? lines : ["No changes"]);
    if (argv["dry-run"]) return 0;
    if (lines.length && await question("Are you sure you want to apply these changes? [y/N] ") !== "y") return 1;
  }

  if (!preview) await planStorage(config);
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  const directory = await open(stateDirectory, directoryFlags);
  try {
    // flock locks the inherited open file description until this handle is closed.
    const lock = spawnSync("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", directory.fd] });
    if (lock.error) throw lock.error;
    if (lock.status !== 0) throw new Error(`Cannot lock storage state: ${lock.stderr.toString().trim() || "another run is active"}`);
    const plan = await planStorage(config);
    if (preview && !isDeepStrictEqual(preview, plan)) throw new Error("Storage plan changed during confirmation. Run again to review it.");
    await applyStorage(plan);
    const lines = summary(plan, false);
    if (lines.length || argv.confirm === false) await printSummary(lines.length ? lines : ["No changes"]);
    return 0;
  } finally {
    await directory.close();
  }
}
