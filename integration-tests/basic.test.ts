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
    }, 30000);
});

describe("Basic", () => {
    let container: StartedTestContainer;
    beforeEach(async () => {
        const image = await GenericContainer
            .fromDockerfile(".", "integration-tests/Dockerfile")
            .build();

        container = await image.withEntrypoint(["sleep", "infinity"]).start();
    });

    test("should handle invalid config", async () => {
        const { output, stdout, stderr, exitCode } = await container.exec(["npx", "--yes", "dist.tgz", "--config", "invalid_config.json"]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Error: ENOENT");
    });

    afterEach(async () => {
        await container.stop();
    });
});