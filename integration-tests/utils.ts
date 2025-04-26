import { StartedTestContainer } from "testcontainers";

export async function ensurePermissions(container: StartedTestContainer, path: string, expected: string) {
    const { stdout, stderr, exitCode } = await container.exec(["stat", "--format", "%a %U %G", path]);
    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(stdout.trim()).toBe(expected);
}

export async function ensureNotExists(container: StartedTestContainer, path: string) {
    const { stderr, exitCode } = await container.exec(["stat", path]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No such file or directory");
}