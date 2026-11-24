# Linux Directory Provisioner

[![Version](https://img.shields.io/npm/v/@watonomous/linux-directory-provisioner)](https://npmjs.org/package/@watonomous/linux-directory-provisioner)
[![Publish to NPM](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/npm-publish-github-packages.yml/badge.svg)](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/npm-publish-github-packages.yml)
[![Test and Lint](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/test-and-lint.yml/badge.svg)](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/test-and-lint.yml)

Tool to provision Linux users and groups. Useful for provisioning a large number of users and groups. Much faster than [ansible.builtin.user](https://github.com/ansible/ansible/blob/d664f13b4a117b324f107b603e9b8e2bb9af50c5/lib/ansible/modules/user.py) and [ansible.builtin.group](https://github.com/ansible/ansible/blob/d664f13b4a117b324f107b603e9b8e2bb9af50c5/lib/ansible/modules/group.py). Used internally at [WATcloud](https://cloud.watonomous.ca).

## Getting started

1. Prepare a configuration file in the format specified in [src/schema.mjs](./src/schema.mjs).
2. Run the following command to run the provisioner:
```bash
npx @watonomous/linux-directory-provisioner@^0.0.6 --config=path_to_config.json
```

## Storage mode

Run the provisioner as root on the storage server with `--storage`. Pass one
complete storage config for the host. Use `--dry-run` to preview changes and
`--no-confirm` to apply them unattended.

```bash
provision-directory --storage --no-confirm --config - < storage.json
```

```json
{
  "roots": ["/mnt/wato-drive2-export/users", "/mnt/wato-drive2-export/affiliations"],
  "groups": [{ "groupname": "robotics", "gid": 23001 }],
  "directories": [
    { "path": "/mnt/wato-drive2-export/users/alex", "owner": 21001, "group": 21001, "mode": "0700" },
    { "path": "/mnt/wato-drive2-export/affiliations/robotics", "owner": "root", "group": "robotics", "mode": "2775" }
  ]
}
```

List at least one existing directory in `roots`. Choose a directory on the data
disk, such as `/mnt/wato-drive2-export/users`. The mount point itself can still
exist when the disk is unmounted. A missing root stops both preview and apply
before any changes.

Use absolute, symlink-free paths with one row per folder. Each managed path must
be strictly below a root. Missing parents below a root are created as
`0755 root:root`. Owners and groups can use numeric IDs or names that resolve
on the storage server. Numeric ownership can refer to users with no local
account. Give each mode as a quoted string of three or four octal digits, such as
`"750"` or `"0770"`. The optional
`groups` list creates missing groups with the specified GIDs and reuses existing
groups only if their GIDs match. A GID mismatch stops the run before any changes.

The provisioner records managed paths and their configured modes in
`/var/lib/linux-directory-provisioner/storage.json`. The first apply creates the
state directory and file. If the directory already exists and the file is missing,
the run fails. If a first apply was interrupted before writing the file, remove the
empty state directory and run again. Concurrent applies are refused while another
run holds the lock.

Removing a row locks the
directory with its configured read and execute bits, clearing write and special bits.
For example, `0700` becomes `0500`, `0750` becomes `0550`, and `2775` becomes `0555`.

The lock prevents adding or removing entries at the top level. Files and
subdirectories keep their own permissions, so existing contents can still be
writable. The directory owner can undo the lock with `chmod`. After locking a
path, the provisioner stops tracking it. An empty `directories` list locks
every tracked directory on the host, subject to the lock limit.

The default limit is 10 locks per run. If the plan exceeds the limit, both
preview and apply list every proposed lock and exit with status 1 before making
changes. For a deliberate cleanup, pass the same limit to both commands,
for example `--dry-run --max-locks=11` to preview and `--max-locks=11` to apply.

## Publishing to NPM

1. Increment the version number in `package.json`:
```bash
npm version prerelease --preid alpha
# or
npm version patch # or minor or major
```

2. Merge the changes into main ([example for `0.0.4-alpha.3`](https://github.com/WATonomous/linux-directory-provisioner/pull/13)).
3. Create a release on GitHub with the appropriate tag name (e.g. create a tag `v0.0.4-alpha.3` during release creation).
4. The GitHub Action pipeline will automatically publish the new version to NPM.

## Development

```bash
# install dependencies
npm ci
# run
npm run start
# lint
npm run lint
# run unit tests
npm run test -- src
# run integration tests (make sure the Docker socket is in the default location or set DOCKER_HOST)
npm run test -- integration-tests
```
