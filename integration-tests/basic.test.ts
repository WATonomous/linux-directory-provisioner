import { GenericContainer, StartedTestContainer } from "testcontainers";


describe("Sanity", () => {
    test("should start properly", async () => {
        const image = await GenericContainer
            .fromDockerfile(".", "integration-tests/Dockerfile")
            .build();

        const container = await image.withEntrypoint(["sleep", "infinity"]).start();

        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--help"]);
            expect(exitCode).toBe(0);
            expect(stderr).toContain("Usage: ");
        }

        await container.stop();
    }, 60000);
});

describe("Basic", () => {
    let basicConfig: Record<string, any>;
    let container: StartedTestContainer;
    beforeEach(async () => {
        const image = await GenericContainer
            .fromDockerfile(".", "integration-tests/Dockerfile")
            .build();

        container = await image.withEntrypoint(["sleep", "infinity"]).start();

        basicConfig = {
            users: [
                {
                    username: "user1",
                    password: "$2y$10$cBoQeDeYs6GCdPpucu2RNOnuhj9PmRCmQ1xgCXStf1/MHiLokThnu",
                    update_password: "on_create",
                    uid: 1001,
                    primary_group: "group1",
                },
                {
                    username: "user2",
                    password: "$2y$10$Bmt9i/P0rHuB/x0Mr.tklO1YpZlR7M7sCVqA1XUd5hIDSV51M77P2",
                    update_password: "on_create",
                    uid: 1002,
                    primary_group: "group2",
                }
            ],
            groups: [
                {
                    groupname: "group1",
                    gid: 1501
                },
                {
                    groupname: "group2",
                    gid: 1502
                }
            ],
            managed_uid_range: [1001, 1002],
            managed_gid_range: [1501, 1502],
        };
    }, 60000);

    test("should handle missing config", async () => {
        const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--config", "nonexistent.json"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Error: ENOENT");
    }, 60000);

    test("should handle invalid config", async () => {
        await container.copyContentToContainer([{ content: JSON.stringify({ invalid_property: "test" }), target: "/app/config.json" }]);
        const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--config", "/app/config.json"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("must NOT have additional properties");
        expect(stderr).toContain("{ additionalProperty: 'invalid_property' }");
    }, 60000);

    test("should create users according to config", async () => {
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/passwd"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("user1:x:1001:1501");
            expect(stdout).toContain("user2:x:1002:1502");
        }
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/group"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("group1:x:1501");
            expect(stdout).toContain("group2:x:1502");
        }

        // Check that the user passwords work
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/shadow"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain(`user1:${basicConfig.users[0].password}`);
            expect(stdout).toContain(`user2:${basicConfig.users[1].password}`);
        }
    }, 60000);

    test("should populate SSH keys correctly", async () => {
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check SSH keys
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/home/user1/.ssh/authorized_keys"]);
            expect(exitCode).toBe(0);
            for (const key of basicConfig.users[0].ssh_authorized_keys) {
                expect(stdout).toContain(key);
            }
        }
    }, 60000);

    test("should set custom shell correctly", async () => {
        basicConfig.users[0].shell = "/bin/zsh";

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check shell
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/passwd"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("user1:/bin/zsh");
        }
    }, 60000);

    test("should assign users to additional groups", async () => {
        basicConfig.users[0].additional_groups = ["group3"];
        basicConfig.users[1].additional_groups = ["group3", "group4"];
        basicConfig.groups.push({
            groupname: "group3",
            gid: 1503
        },
            {
                groupname: "group4",
                gid: 1504
            });

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/group"]);
            expect(exitCode).toBe(0);
            expect(stdout).toMatch(/group3:x:1503:.*user1/);
            expect(stdout).toMatch(/group3:x:1503:.*user2/);
            expect(stdout).toMatch(/group4:x:1504:.*user2/);
            expect(stdout).not.toMatch(/group4:x:1504:.*user1/);
        }
    }, 60000);

    test("should respect user_ssh_key_base_dir", async () => {
        basicConfig.user_ssh_key_base_dir = "/tmp/ssh-keys/%u/%U/.ssh";
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check SSH keys
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/tmp/ssh-keys/user1/1001/.ssh/authorized_keys"]);
            expect(exitCode).toBe(0);
            for (const key of basicConfig.users[0].ssh_authorized_keys) {
                expect(stdout).toContain(key);
            }
        }
    }, 60000);

    test("should respect use_strict_ssh_key_dir_permissions", async () => {
        basicConfig.user_ssh_key_base_dir = "/tmp/ssh-keys/%u/%U/.ssh";
        basicConfig.use_strict_ssh_key_dir_permissions = true;
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check folder permissions
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["stat", "--format", "%a %U %G", "/tmp/ssh-keys/"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("755 root root");
        }
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["stat", "--format", "%a %U %G", "/tmp/ssh-keys/user1"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("750 root group1");
        }
    }, 60000);

    test("should delete users and groups that have been removed from the config", async () => {
        basicConfig.user_ssh_key_base_dir = "/tmp/ssh-keys/%u/%U/.ssh";

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Delete users and groups
        basicConfig.users.splice(1, 1);
        basicConfig.groups.splice(1, 1);
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Update users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/passwd"]);
            expect(exitCode).toBe(0);
            expect(stdout).not.toContain("user2");
        }
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/group"]);
            expect(exitCode).toBe(0);
            expect(stdout).not.toContain("group2");
        }
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["stat", "/home/user2"]);
            expect(exitCode).toBe(1);
            expect(stderr).toContain("No such file or directory");
        }
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["stat", "/tmp/ssh-keys/user2/1002/.ssh"]);
            expect(exitCode).toBe(1);
            expect(stderr).toContain("No such file or directory");
        }
    }, 60000);

    test("should create and delete managed user directories", async () => {
        basicConfig.managed_user_directories = ["/test/%u/%U/.test"];
        
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        {
            const { output, stdout, stderr, exitCode } = await container.exec(["stat", "/test/user1/1001/.test"]);
            expect(exitCode).toBe(0);
        }
        
        basicConfig.users.splice(0, 1);
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
    
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        {
            const { output, stdout, stderr, exitCode } = await container.exec(["stat", "/test/user1/1001/.test"]);
            console.log(output, stdout, stderr, exitCode)
            expect(exitCode).toBe(1);
            expect(stderr).toContain("No such file or directory");
        }
    })

    afterEach(async () => {
        await container.stop();
    });
});