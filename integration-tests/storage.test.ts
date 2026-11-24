import { GenericContainer } from "testcontainers";
import { ensureExists, ensureNotExists } from "./utils";

test("provisions and locks storage directories without touching user accounts", async () => {
    const image = await GenericContainer
        .fromDockerfile(".", "integration-tests/Dockerfile")
        .build();
    const container = await image.withEntrypoint(["sleep", "infinity"]).start();

    try {
        const install = await container.exec([
            "npm", "install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "./dist.tgz",
        ]);
        expect(install.exitCode).toBe(0);
        const setup = await container.exec(["sh", "-ec", `
            mkdir -p /tmp/account-guards /mnt/storage/unrelated
            chown 0:777 /mnt/storage
            chmod 2775 /mnt/storage
            for cmd in useradd usermod userdel chpasswd passwd; do
                printf '#!/bin/sh\nprintf "%%s\\n" "$0" >> /tmp/account-command-called\nexit 99\n' > "/tmp/account-guards/$cmd"
                chmod +x "/tmp/account-guards/$cmd"
            done
        `]);
        expect(setup.exitCode).toBe(0);

        const team = "/mnt/storage/affiliations/team";
        const personal = "/mnt/storage/users/private";
        const retained = "/mnt/storage/users/retained";
        const config = {
            roots: ["/mnt/storage"],
            groups: [{ groupname: "storage-team", gid: 23145 }, { groupname: "root", gid: 0 }],
            directories: [
                { path: team, owner: 21345, group: "storage-team", mode: "2775" },
                { path: personal, owner: "root", group: "storage-team", mode: "0700" },
                { path: retained, owner: "root", group: "root", mode: "0750" },
            ],
        };
        const stateDir = "/var/lib/linux-directory-provisioner";
        const stateFile = `${stateDir}/storage.json`;
        const writeContainerFile = async (target: string, content: string) => {
            expect((await container.exec(["sh", "-ec", 'printf "%s" "$1" > "$2"', "storage", content, target])).exitCode).toBe(0);
        };
        const invoke = async (dryRun = false, input: unknown = config, options: { holdLock?: boolean, maxLocks?: number } = {}) => (
            container.exec([
                "sh", "-ec", `
                    export PATH="/tmp/account-guards:/app/node_modules/.bin:$PATH"
                    umask 077
                    printf "%s" "$1" > /app/storage.json
                    shift
                    ${options.holdLock ? `flock ${stateDir}` : ""} provision-directory --storage --no-confirm --config - "$@" < /app/storage.json
                `, "storage", JSON.stringify(input), ...(dryRun ? ["--dry-run"] : []),
                ...(options.maxLocks === undefined ? [] : [`--max-locks=${options.maxLocks}`]),
            ])
        );
        const run = async (dryRun = false) => {
            const result = await invoke(dryRun);
            expect(result.stderr.trim()).toBe("");
            expect(result.exitCode).toBe(0);
            return result.stdout.trim();
        };
        const stat = async (...paths: string[]) => {
            const result = await container.exec(["stat", "--format", "%a %u %g", ...paths]);
            expect(result.exitCode).toBe(0);
            return result.stdout.trim().split("\n");
        };
        const accountsBefore = await container.exec(["cat", "/etc/passwd", "/etc/shadow"]);
        expect(accountsBefore.exitCode).toBe(0);

        const diskRoot = "/mnt/storage/disk-data";
        const missingDisk = {
            ...config, roots: [...config.roots, diskRoot],
            directories: [...config.directories, { ...config.directories[0], path: `${diskRoot}/nested/leaf` }],
        };
        for (const dryRun of [true, false]) {
            const result = await invoke(dryRun, missingDisk);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(`storage root missing: ${diskRoot} (is the disk mounted?)`);
            await ensureNotExists(container, diskRoot);
            await ensureNotExists(container, stateDir);
            await ensureNotExists(container, "/mnt/storage/affiliations");
            expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(2);
        }
        for (const path of ["/mnt/storage", "/mnt/storage-other/leaf", "/mnt/storage/../elsewhere"]) {
            const result = await invoke(false, { ...config, directories: [{ ...config.directories[0], path }] });
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain("strictly under a storage root");
        }
        for (const roots of [["/"], ["//"], ["/mnt/.."]]) {
            const result = await invoke(false, { ...config, roots });
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain("Storage root cannot be /");
            await ensureNotExists(container, stateDir);
        }

        const link = "/mnt/storage/link";
        expect((await container.exec(["ln", "-s", "/mnt/storage/unrelated", link])).exitCode).toBe(0);
        const symlink = await invoke(false, {
            ...config, directories: [...config.directories, { ...config.directories[0], path: `${link}/leaf` }],
        });
        expect(symlink.exitCode).toBe(1);
        expect(symlink.stderr).toContain(`Cannot open storage directory ${link}/leaf`);
        await ensureNotExists(container, "/mnt/storage/unrelated/leaf");
        const mismatch = await invoke(false, {
            ...config, groups: [config.groups[0], { groupname: "root", gid: 23146 }],
        });
        expect(mismatch.exitCode).toBe(1);
        expect(mismatch.stderr).toContain("Storage group root has GID 0, expected 23146");
        const invalidMode = await invoke(false, {
            ...config, directories: [{ ...config.directories[0], mode: 504 }],
        });
        expect(invalidMode.exitCode).toBe(1);
        expect(invalidMode.stderr).toContain("Invalid storage config");

        expect(await run(true)).toBe(`Groups to create ["storage-team"]\nDirectories to create ["${team}","${personal}","${retained}"]`);
        expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(2);
        await ensureNotExists(container, "/mnt/storage/affiliations");
        await ensureNotExists(container, "/mnt/storage/users");
        await ensureNotExists(container, stateDir);

        expect((await container.exec(["mkdir", "-m", "0700", stateDir])).exitCode).toBe(0);
        const missing = await invoke();
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain(`Missing storage state file: ${stateFile}`);
        expect((await container.exec(["rmdir", stateDir])).exitCode).toBe(0);
        await ensureNotExists(container, "/mnt/storage/affiliations");
        await ensureNotExists(container, "/mnt/storage/users");
        expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(2);

        expect((await invoke(false, { roots: config.roots, directories: [] })).exitCode).toBe(0);
        expect((await container.exec(["cat", stateFile])).stdout).toBe("{}");
        const rootStat = async () => {
            const result = await container.exec(["stat", "--format", "%a %u %g %z", "/"]);
            expect(result.exitCode).toBe(0);
            return result.stdout;
        };
        const rootBefore = await rootStat();
        for (const contents of [
            '{"":493}', '{"/":493}', '{"relative":493}', '{"/mnt/../tmp":493}', '[]', 'null',
            '{"/mnt":"493"}', '{"/mnt":-1}', '{"/mnt":4096}', '{"/mnt":1.5}',
        ]) {
            await writeContainerFile(stateFile, contents);
            const invalid = await invoke();
            expect(invalid.exitCode).toBe(1);
            expect(invalid.stderr).toContain("Invalid storage state");
            expect((await container.exec(["cat", stateFile])).stdout).toBe(contents);
        }
        expect(await rootStat()).toBe(rootBefore);
        await ensureNotExists(container, "/mnt/storage/affiliations");
        await ensureNotExists(container, "/mnt/storage/users");
        expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(2);
        await writeContainerFile(stateFile, "{}");

        const busy = await invoke(false, config, { holdLock: true });
        expect(busy.exitCode).toBe(1);
        expect(busy.stderr).toContain("another run is active");
        expect((await container.exec(["cat", stateFile])).stdout).toBe("{}");
        await ensureNotExists(container, "/mnt/storage/affiliations");
        expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(2);

        // A checkpoint from the previous release must never be treated as a managed path.
        await writeContainerFile(stateFile, JSON.stringify({ pendingParent: { path: "/mnt/storage/unrelated" } }));
        expect(await run()).toBe(`Created groups ["storage-team"]\nCreated directories ["${team}","${personal}","${retained}"]`);
        expect((await container.exec(["getent", "group", "storage-team", "root"])).stdout.trim())
            .toBe("storage-team:x:23145:\nroot:x:0:");
        expect(await stat(team, personal, retained, "/mnt/storage/affiliations", "/mnt/storage/users"))
            .toEqual(["2775 21345 23145", "700 0 23145", "750 0 0", "755 0 0", "755 0 0"]);
        expect(await stat("/mnt/storage")).toEqual(["2775 0 777"]);
        const ctimes = async () => {
            const result = await container.exec(["stat", "--format", "%z", team, personal, retained]);
            expect(result.exitCode).toBe(0);
            return result.stdout;
        };
        const beforeNoop = await ctimes();
        expect(await run()).toBe("No changes");
        expect(await run(true)).toBe("No changes");
        expect(await ctimes()).toBe(beforeNoop);

        const asMember = (...args: string[]) => container.exec([
            "setpriv", "--reuid", "21345", "--regid", "23145", "--clear-groups", ...args,
        ]);
        expect((await asMember("ls", personal)).stderr).toContain("Permission denied");
        expect((await asMember("touch", `${team}/before-lock`)).exitCode).toBe(0);
        const written = await container.exec(["touch", `${team}/keep.txt`, `${personal}/keep.txt`]);
        expect(written.exitCode).toBe(0);
        const departed = config.directories.splice(0, 2);
        config.groups = [];
        expect(await run(true)).toBe(`Directories to lock ["${team}","${personal}"]`);
        expect(await stat(team, personal)).toEqual(["2775 21345 23145", "700 0 23145"]);

        expect(await run()).toBe(`Locked directories ["${team}","${personal}"]`);
        expect(await stat(team, personal, retained)).toEqual(["555 21345 23145", "500 0 23145", "750 0 0"]);
        const denied = await asMember("touch", `${team}/after-lock`);
        expect(denied.exitCode).toBe(1);
        expect(denied.stderr).toContain("Permission denied");
        expect((await asMember("ls", personal)).stderr).toContain("Permission denied");
        expect((await asMember("sh", "-c", 'echo kept >> "$1"', "storage", `${team}/before-lock`)).exitCode).toBe(0);
        await ensureExists(container, `${team}/keep.txt`);
        await ensureExists(container, `${personal}/keep.txt`);
        expect(await stat("/mnt/storage/unrelated")).toEqual(["755 0 0"]);
        expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(0);
        expect(await run()).toBe("No changes");

        const remaining = config.directories.splice(0);
        expect(await run()).toBe(`Locked directories ["${retained}"]`);
        expect(await stat(retained)).toEqual(["550 0 0"]);
        expect((await asMember("chmod", "0755", team)).exitCode).toBe(0);
        expect(await run()).toBe("No changes");
        expect(await stat(team)).toEqual(["755 21345 23145"]);
        config.directories.push(...remaining);
        expect(await run()).toBe(`Updated directories ["${retained}"]`);

        config.directories.push(...departed);
        expect(await run()).toBe(`Updated directories ["${team}","${personal}"]`);
        expect(await stat(team, personal)).toEqual(["2775 21345 23145", "700 0 23145"]);

        const batch = Array.from({ length: 11 }, (_, i) => ({
            path: `/mnt/storage/batch/dir-${i}`, owner: 0, group: 0, mode: "0700",
        }));
        const batchPaths = batch.map(({ path }) => path);
        const withBatch = (rows: typeof batch) => ({ ...config, directories: [...config.directories, ...rows] });
        expect((await invoke(false, withBatch(batch))).exitCode).toBe(0);
        const readState = () => container.exec(["cat", stateFile]);
        const beforeBatch = (await readState()).stdout;
        const extra = "/mnt/storage/should-not-be-created";
        for (const dryRun of [true, false]) {
            const refused = await invoke(dryRun, withBatch([{ ...batch[0], path: extra }]));
            expect(refused.exitCode).toBe(1);
            expect(refused.stderr).toContain(`Refusing to lock 11 directories (--max-locks=10): ${JSON.stringify(batchPaths)}`);
            expect((await readState()).stdout).toBe(beforeBatch);
            expect(await stat(...batchPaths)).toEqual(batch.map(() => "700 0 0"));
            await ensureNotExists(container, extra);
        }
        const allowed = await invoke(false, config, { maxLocks: 11 });
        expect(allowed.exitCode).toBe(0);
        expect(allowed.stdout.trim()).toBe(`Locked directories ${JSON.stringify(batchPaths)}`);
        expect(await stat(...batchPaths)).toEqual(batch.map(() => "500 0 0"));

        const ten = batch.slice(0, 10);
        expect((await invoke(false, withBatch(ten))).exitCode).toBe(0);
        expect(await run()).toBe(`Locked directories ${JSON.stringify(batchPaths.slice(0, 10))}`);
        expect(await stat(...batchPaths)).toEqual(batch.map(() => "500 0 0"));

        const accountsAfter = await container.exec(["cat", "/etc/passwd", "/etc/shadow"]);
        expect(accountsAfter.exitCode).toBe(0);
        expect(accountsAfter.stdout).toBe(accountsBefore.stdout);
        await ensureNotExists(container, "/tmp/account-command-called");
    } finally {
        await container.stop();
    }
}, 180000);
