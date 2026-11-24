import { GenericContainer } from "testcontainers";
import { ensureNotExists } from "./utils";

test("provisions storage groups and directories without touching user accounts", async () => {
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
            groups: [{ groupname: "storage-team", gid: 23145 }, { groupname: "root", gid: 0 }],
            directories: [
                { path: team, owner: 21345, group: "storage-team", mode: "2775" },
                { path: personal, owner: "root", group: "storage-team", mode: "0700" },
                { path: retained, owner: "root", group: "root", mode: "0750" },
            ],
        };
        const stateDir = "/var/lib/linux-directory-provisioner";
        const invoke = async (dryRun = false, input: unknown = config, holdLock = false) => (
            container.exec([
                "sh", "-ec", `
                    export PATH="/tmp/account-guards:/app/node_modules/.bin:$PATH"
                    umask 077
                    printf "%s" "$1" > /app/storage.json
                    shift
                    ${holdLock ? `flock ${stateDir}` : ""} provision-directory --storage --no-confirm --config - "$@" < /app/storage.json
                `, "storage", JSON.stringify(input), ...(dryRun ? ["--dry-run"] : []),
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

        expect((await container.exec(["mkdir", "-m", "0700", stateDir])).exitCode).toBe(0);
        const busy = await invoke(false, config, true);
        expect(busy.exitCode).toBe(1);
        expect(busy.stderr).toContain("another run is active");
        await ensureNotExists(container, "/mnt/storage/affiliations");
        expect((await container.exec(["getent", "group", "storage-team"])).exitCode).toBe(2);

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

        const accountsAfter = await container.exec(["cat", "/etc/passwd", "/etc/shadow"]);
        expect(accountsAfter.exitCode).toBe(0);
        expect(accountsAfter.stdout).toBe(accountsBefore.stdout);
        await ensureNotExists(container, "/tmp/account-command-called");
    } finally {
        await container.stop();
    }
}, 180000);
