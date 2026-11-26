import { execFile, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { question } from "zx";

const exec = promisify(execFile);
const stateDirectory = "/var/lib/linux-directory-provisioner";
const statePath = `${stateDirectory}/storage.json`;
// eslint-disable-next-line no-bitwise
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function missingRoot(root) {
  return new Error(`storage root missing: ${root} (is the disk mounted?)`);
}

async function openDirectory(path, root) {
  // Open the root without creation, then anchor every mkdir below its descriptor.
  let directory = root ? await openDirectory(root) : await open("/", directoryFlags);
  if (!directory) throw missingRoot(root);
  try {
    const components = path.slice(root?.length ?? 0).split("/").filter(Boolean);
    for (const [index, component] of components.entries()) {
      // Anchor each lookup to the opened parent so a symlink swap cannot redirect it.
      const childPath = `/proc/self/fd/${directory.fd}/${component}`;
      let child;
      try {
        child = await open(childPath, directoryFlags);
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Cannot open storage directory ${path}`, { cause: error });
        if (!root) return null;
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

async function loadState() {
  const directory = await openDirectory(stateDirectory);
  if (!directory) return new Map();
  try {
    const { uid, mode } = await directory.stat();
    // eslint-disable-next-line no-bitwise
    if (uid !== 0 || (mode & 0o022) !== 0) throw new Error(`Unsafe storage state directory: ${stateDirectory}`);
    const contents = await readFile(`/proc/self/fd/${directory.fd}/storage.json`, "utf8");
    const data = JSON.parse(contents);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Invalid storage state: expected an object in ${statePath}`);
    }
    const state = new Map(Object.entries(data));
    state.delete("pendingParent"); // Ignore checkpoints written by older versions.
    for (const [path, savedMode] of state) {
      if (path === "/" || path.includes("\0") || resolve(path) !== path) {
        throw new Error(`Invalid storage state path: ${JSON.stringify(path)}`);
      }
      if (!Number.isInteger(savedMode) || savedMode < 0 || savedMode > 0o7777) {
        throw new Error(`Invalid storage state mode for ${path}`);
      }
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Missing storage state file: ${statePath}`, { cause: error });
    throw error;
  } finally {
    await directory.close();
  }
}

async function saveState(state, stateDir) {
  const temporary = `${statePath}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(Object.fromEntries(state)));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, statePath);
  await stateDir.sync();
}

async function planStorage(config, maxLocks) {
  const roots = config.roots.map((root) => resolve(root)).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (root === "/") throw new Error("Storage root cannot be /");
    if (!await directoryStat(root)) throw missingRoot(root);
  }
  const previous = await loadState();
  const desired = new Map();
  const groups = new Map();
  const owners = new Map();
  const newGroups = [];
  const newGids = new Set();
  const directories = [];
  const locked = [];

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
    const root = roots.find((candidate) => path.startsWith(`${candidate}/`));
    if (!root || roots.includes(path)) throw new Error(`Storage directory must be strictly under a storage root: ${row.path}`);
    if (desired.has(path)) throw new Error(`Duplicate storage directory: ${path}`);
    const mode = parseInt(row.mode, 8);
    desired.set(path, mode);

    const uid = await resolveId("passwd", row.owner, owners);
    const gid = await resolveId("group", row.group, groups);
    const stat = await directoryStat(path);
    // eslint-disable-next-line no-bitwise
    if (!stat || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode) {
      directories.push({ path, root, uid, gid, mode, create: !stat });
    }
  }

  for (const [path, mode] of previous) {
    if (desired.has(path) || !await directoryStat(path)) continue;
    // eslint-disable-next-line no-bitwise
    locked.push({ path, mode: mode & 0o555 });
  }
  if (locked.length > maxLocks) {
    const paths = locked.map(({ path }) => path);
    throw new Error(`Refusing to lock ${paths.length} directories (--max-locks=${maxLocks}): ${JSON.stringify(paths)}`);
  }
  return { previous, desired, newGroups, directories, locked };
}

function summary(plan, planned) {
  const changes = [
    ["Groups to create", "Created groups", plan.newGroups.map(({ groupname }) => groupname)],
    ["Directories to create", "Created directories", plan.directories.filter(({ create }) => create).map(({ path }) => path)],
    ["Directories to update", "Updated directories", plan.directories.filter(({ create }) => !create).map(({ path }) => path)],
    ["Directories to lock", "Locked directories", plan.locked.map(({ path }) => path)],
  ];
  return changes.filter(([, , items]) => items.length).map(([future, past, items]) => (
    `${planned ? future : past} ${JSON.stringify(items)}`
  ));
}

async function printSummary(lines) {
  await new Promise((done) => { process.stdout.write(`${lines.join("\n")}\n`, done); });
}

async function applyStorage({ previous, desired, newGroups, directories, locked }, stateDir) {
  process.umask(0o022);
  for (const { groupname, gid } of newGroups) {
    await exec("groupadd", ["--gid", String(gid), "--", groupname]);
  }

  // Record enrolled paths before touching them so an interrupted apply cannot lose track of one.
  const state = new Map([...previous, ...desired]);
  if ([...desired].some(([path, mode]) => previous.get(path) !== mode)) await saveState(state, stateDir);

  for (const { path, root, uid, gid, mode } of directories) {
    const directory = await openDirectory(path, root);
    try {
      const stat = await directory.stat();
      if (stat.uid !== uid || stat.gid !== gid) await directory.chown(uid, gid);
      await directory.chmod(mode);
    } finally {
      await directory.close();
    }
  }

  for (const { path, mode } of locked) {
    const directory = await openDirectory(path);
    if (!directory) continue;
    try {
      await directory.chmod(mode);
      state.delete(path);
    } finally {
      await directory.close();
    }
  }
  if (locked.length) await saveState(state, stateDir);
}

export default async function provisionStorage(config, argv) {
  const limit = argv["max-locks"] ?? 10;
  const maxLocks = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : limit;
  if (!Number.isSafeInteger(maxLocks) || maxLocks < 0) throw new Error("--max-locks must be a non-negative integer");
  let preview;
  if (argv["dry-run"] || argv.confirm !== false) {
    preview = await planStorage(config, maxLocks);
    const lines = summary(preview, true);
    await printSummary(lines.length ? lines : ["No changes"]);
    if (argv["dry-run"]) return 0;
    if (lines.length && await question("Are you sure you want to apply these changes? [y/N] ") !== "y") return 1;
  }

  // Reject an invalid first run before creating the state directory.
  if (!preview && !await directoryStat(stateDirectory)) await planStorage(config, maxLocks);
  const created = await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  const directory = await open(stateDirectory, directoryFlags);
  try {
    // flock locks the inherited open file description until this handle is closed.
    const lock = spawnSync("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", directory.fd] });
    if (lock.error) throw lock.error;
    if (lock.status !== 0) throw new Error(`Cannot lock storage state: ${lock.stderr.toString().trim() || "another run is active"}`);
    if (created) await saveState(new Map(), directory);
    const plan = await planStorage(config, maxLocks);
    if (preview && !isDeepStrictEqual(preview, plan)) throw new Error("Storage plan changed during confirmation. Run again to review it.");
    await applyStorage(plan, directory);
    const lines = summary(plan, false);
    if (lines.length || argv.confirm === false) await printSummary(lines.length ? lines : ["No changes"]);
    return 0;
  } finally {
    await directory.close();
  }
}
