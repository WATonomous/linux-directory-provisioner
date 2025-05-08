import { GenericContainer, TestContainer, StartedTestContainer } from "testcontainers";
import { ensureExists, ensureNotExists, ensurePermissions } from "./utils";


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
    let image: TestContainer;
    let basicConfig: Record<string, any>;
    let container: StartedTestContainer;

    beforeAll(async () => {
        image = await GenericContainer
            .fromDockerfile(".", "integration-tests/Dockerfile")
            .build();
    }, 60000)

    beforeEach(async () => {
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

    test("should not create home directories by default", async () => {
        basicConfig.home_dir = "/tmp/myhome/%u/%U";
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        await ensureNotExists(container, "/tmp/myhome/user1/1001");
        await ensureNotExists(container, "/tmp/myhome/user2/1002");
    }, 60000);

    test("should support custom home directories", async () => {
        basicConfig.home_dir = "/tmp/myhome/%u/%U";
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }
        
        // Check passwd
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/etc/passwd"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("user1:x:1001:1501::/tmp/myhome/user1/1001");
            expect(stdout).toContain("user2:x:1002:1502::/tmp/myhome/user2/1002");
        }
    }, 60000);

    test("should not delete home directories by default", async () => {
        basicConfig.home_dir = "/tmp/myhome/%u/%U";
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        await ensureNotExists(container, "/tmp/myhome/user1/1001");
        await ensureNotExists(container, "/tmp/myhome/user2/1002");

        // Create the home dirs manually
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["mkdir", "-p", "/tmp/myhome/user1/1001", "/tmp/myhome/user2/1002"]);
            expect(exitCode).toBe(0);
        }

        // Delete users and groups
        basicConfig.users = [];
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        await ensureExists(container, "/tmp/myhome/user1/1001");
        await ensureExists(container, "/tmp/myhome/user2/1002");
    }, 60000);

    test("should populate SSH keys correctly", async () => {
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];

        basicConfig.managed_user_directories = [
            "/home/%u",
            "/home/%u/.ssh",
        ]

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check that the appropriate keys exist
        await ensureExists(container, "/home/user1/.ssh/authorized_keys");
        await ensureNotExists(container, "/home/user2/.ssh/authorized_keys");

        // Check permissions
        await ensurePermissions(container, "/home/user1/.ssh/authorized_keys", "600 user1 group1");

        // Check SSH keys
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/home/user1/.ssh/authorized_keys"]);
            expect(exitCode).toBe(0);
            for (const key of basicConfig.users[0].ssh_authorized_keys) {
                expect(stdout).toContain(key);
            }
        }
    }, 60000);

    test("should delete SSH keys when deleting users", async () => {
        basicConfig.ssh_authorized_keys_path = "/tmp/ssh-keys-%u-%U-authorized_keys";
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
        
        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check that the appropriate keys exist
        await ensureExists(container, "/tmp/ssh-keys-user1-1001-authorized_keys");
        await ensureNotExists(container, "/tmp/ssh-keys-user2-1002-authorized_keys");

        // Delete users and groups
        basicConfig.users = [];
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check that the appropriate keys no longer exist
        await ensureNotExists(container, "/tmp/ssh-keys-user1-1001-authorized_keys");
        await ensureNotExists(container, "/tmp/ssh-keys-user2-1002-authorized_keys");
    }, 60000);

    test("should throw an error if the parent directory of the ssh key location does not exist", async () => {
        basicConfig.ssh_authorized_keys_path = "/tmp/ssh-keys/%u/%U/.ssh/authorized_keys";
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
        
        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(1);
            expect(stderr).toContain("No such file or directory");
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

    test("should allow custom ssh key locations", async () => {
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];
        basicConfig.ssh_authorized_keys_path = "/tmp/ssh-keys/%u/%U/.ssh/authorized_keys";

        basicConfig.managed_user_directories = [
            "/tmp/ssh-keys/%u/%U/.ssh",
        ]

        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Create users and groups
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
        }

        // Check that the appropriate keys exist
        await ensureExists(container, "/tmp/ssh-keys/user1/1001/.ssh/authorized_keys");
        await ensureNotExists(container, "/tmp/ssh-keys/user2/1002/.ssh/authorized_keys");

        // Check permissions
        await ensurePermissions(container, "/tmp/ssh-keys/user1/1001/.ssh/authorized_keys", "600 user1 group1");

        // Check content
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["cat", "/tmp/ssh-keys/user1/1001/.ssh/authorized_keys"]);
            expect(exitCode).toBe(0);
            for (const key of basicConfig.users[0].ssh_authorized_keys) {
                expect(stdout).toContain(key);
            }
        }
    }, 60000);

    test("should delete users and groups that have been removed from the config", async () => {
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
    }, 60000);

    test("should create and delete managed user directories", async () => {
        basicConfig.managed_user_directories = ["/test/%u/%U/.test"];
        
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Creating managed user directories for 2 user(s)...");
        }

        // The folder should be owned by the user and not accessible by others
        await ensurePermissions(container, "/test/user1/1001/.test", "700 user1 group1");
        // All the folders leading up to the file should be 755 root root
        await ensurePermissions(container, "/test/user1/1001/", "755 root root");
        await ensurePermissions(container, "/test/user1/", "755 root root");
        await ensurePermissions(container, "/test/", "755 root root");

        basicConfig.users.splice(0, 1);
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
    
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Creating managed user directories for 0 user(s)...")
        }

        await ensureNotExists(container, "/test/user1/1001/.test");
        await ensureExists(container, "/test/user2/1002/.test");
    })

    test("should warn us if managed directories are missing", async () => {
        basicConfig.managed_user_directories = ["/test/%u/%U/.test"];
        basicConfig.ssh_authorized_keys_path = "/tmp/ssh-keys-%u-%U-authorized_keys";
        basicConfig.users[0].ssh_authorized_keys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwLVH+sBKaWb09IfaGkyqF9LEds6UN6grSQTieVD0ZW",
        ];
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Creating managed user directories for 2 user(s)...");
        }

        // manually delete user1's sshAuthorizedKeysPath and managed dir(s)
        await container.exec([
            'rm', '-rf',
            '/test/user1/1001/.test',
            '/tmp/ssh-keys-user1-1001-authorized_keys'
        ]);

        basicConfig.users.splice(0, 1);
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Creating managed user directories for 0 user(s)...");
            expect(stderr).toContain("WARNING: Directory doesn't exist for user user1: /test/user1/1001/.test");
            expect(stderr).toContain("WARNING: No sshAuthorizedKeysPath for user user1");
        }

        await ensureNotExists(container, "/test/user1/1001/.test");
        await ensureNotExists(container, "/tmp/ssh-keys-user1-1001-authorized_keys");
    })

    test("should handle existing managed user directories", async () => {
        // Create the user
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Creating managed user directories for 0 user(s)...");
        }

        // Add a managed user directory
        basicConfig.managed_user_directories = ["/test/%u/%U/.test"];
        await container.copyContentToContainer([{ content: JSON.stringify(basicConfig), target: "/app/config.json" }]);

        // Simulate an existing managed user directory
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["mkdir", "-p", "/test/user1/1001/.test"]);
            expect(exitCode).toBe(0);
        }

        // Provision
        {
            const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--no-confirm", "--config", "/app/config.json"]);
            expect(exitCode).toBe(0);
            expect(stdout).toContain("Creating managed user directories for 1 user(s)...");
        }
    })

    afterEach(async () => {
        await container.stop();
    });
});