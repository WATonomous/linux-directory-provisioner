import fsPromises from "node:fs/promises";
import { deepEqual, getSSHKeys, diffProperties, getExistingDirectory, parseIECSize, objectMap } from "./utils";

describe("deepEqual", () => {
  // Test case: Comparing two identical objects
  test("should return true when comparing two identical objects", () => {
    const obj1 = { name: "John", age: 30 };
    const obj2 = { name: "John", age: 30 };
    expect(deepEqual(obj1, obj2)).toBe(true);
  });

  // Test case: Comparing two objects with different values
  test("should return false when comparing two objects with different values", () => {
    const obj1 = { name: "John", age: 30 };
    const obj2 = { name: "John", age: 25 };
    expect(deepEqual(obj1, obj2)).toBe(false);
  });

  // Test case: Comparing two objects with different properties
  test("should return false when comparing two objects with different properties", () => {
    const obj1 = { name: "John", age: 30 };
    const obj2 = { name: "John", city: "New York" };
    expect(deepEqual(obj1, obj2)).toBe(false);
  });

  // Test case: Comparing objects with nested objects
  test("should return true when comparing objects with nested objects", () => {
    const obj1 = { name: "John", address: { city: "New York", country: "USA" } };
    const obj2 = { name: "John", address: { city: "New York", country: "USA" } };
    expect(deepEqual(obj1, obj2)).toBe(true);
  });

  // Test case: Comparing objects with nested arrays
  test("should return true when comparing objects with nested arrays", () => {
    const obj1 = { name: "John", hobbies: ["reading", "coding"] };
    const obj2 = { name: "John", hobbies: ["reading", "coding"] };
    expect(deepEqual(obj1, obj2)).toBe(true);
  });

  // Test case: Comparing objects with different nested objects
  test("should return false when comparing objects with different nested objects", () => {
    const obj1 = { name: "John", address: { city: "New York", country: "USA" } };
    const obj2 = { name: "John", address: { city: "Los Angeles", country: "USA" } };
    expect(deepEqual(obj1, obj2)).toBe(false);
  });

  // Test case: Comparing objects with different nested arrays
  test("should return false when comparing objects with different nested arrays", () => {
    const obj1 = { name: "John", hobbies: ["reading", "coding"] };
    const obj2 = { name: "John", hobbies: ["reading", "swimming"] };
    expect(deepEqual(obj1, obj2)).toBe(false);
  });
});

describe("diffProperties", () => {
  // Test case: Comparing two objects with identical properties
  test("should return an empty set when comparing two objects with identical properties", () => {
    const obj1 = { name: "John", age: 30 };
    const obj2 = { name: "John", age: 30 };
    expect(diffProperties(obj1, obj2)).toEqual(new Set());
  });

  // Test case: Comparing two objects with different properties
  test("should throw an error when object properties are different", () => {
    const obj1 = { name: "John", age: 30 };
    const obj2 = { name: "John", city: "New York" };

    expect(() => diffProperties(obj1, obj2)).toThrow("Object keys don't match");
  });

  // Test case: Comparing undefined objects
  test("should throw an error when comparing undefined objects", () => {
    const obj1 = undefined;
    const obj2 = { name: "John", age: 30 };
    expect(() => diffProperties(obj1, obj2)).toThrow();
  });
});

describe("getSSHKeys", () => {
  // Test case: Getting SSH keys for multiple users
  test("should return SSH keys for multiple users", async () => {
    const users = [
      { username: "user1", uid: 1001 },
      { username: "user2", uid: 1002 },
    ]
    const base_dir = "/home/%u/.ssh";
    const expectedKeys = {
      user1: ["ssh_key1", "ssh_key2"],
      user2: ["ssh_key3", "ssh_key4"],
    };

    // Mock the readFile function
    jest.spyOn(fsPromises, "readFile").mockImplementation((path) => {
      if (path === "/home/user1/.ssh/authorized_keys") {
        return Promise.resolve("ssh_key1\nssh_key2\n");
      }
      if (path === "/home/user2/.ssh/authorized_keys") {
        return Promise.resolve("ssh_key3\nssh_key4\n");
      }
    });

    const result = await getSSHKeys(users, base_dir);
    expect(result).toEqual(expectedKeys);
  });

  test("should template %U to the user's UID", async () => {
    const users = [
      { username: "user1", uid: 1001 },
      { username: "user2", uid: 1002 },
    ];
    const base_dir = "/home/%U/.ssh";
    const expectedKeys = {
      user1: ["ssh_key1_uid", "ssh_key2_uid"],
      user2: ["ssh_key3_uid", "ssh_key4_uid"],
    };

    // Mock the readFile function
    jest.spyOn(fsPromises, "readFile").mockImplementation((path) => {
      if (path === "/home/1001/.ssh/authorized_keys") {
        return Promise.resolve("ssh_key1_uid\nssh_key2_uid\n");
      }
      if (path === "/home/1002/.ssh/authorized_keys") {
        return Promise.resolve("ssh_key3_uid\nssh_key4_uid\n");
      }
    });

    const result = await getSSHKeys(users, base_dir);
    expect(result).toEqual(expectedKeys);
  });
});

describe("getExistingDirectory", () => {
  // Test case: Valid directory data
  test("should return the correct directory data", async () => {
    // Mock the readFile function
    jest.spyOn(fsPromises, "readFile").mockImplementation((path) => {
      if (path === "/etc/passwd") {
        return Promise.resolve("user1:x:1001:1001:User 1:/home/user1:/bin/bash\nuser2:x:1002:1002:User 2:/home/user2:/bin/bash");
      }
      if (path === "/etc/shadow") {
        return Promise.resolve("user1:$6$random_salt$encrypted_password1\nuser2:$6$random_salt$encrypted_password2");
      }
      if (path === "/etc/group") {
        return Promise.resolve("group1:x:1001:user1\ngroup2:x:1002:user2\ngroup3:x:1003:user1,user2");
      }
    });

    jest.spyOn(fsPromises, "readdir").mockImplementation((path) => {
      if (path === "/var/lib/systemd/linger/") {
        return Promise.resolve(["user1"]);
      }
    });

    const expectedData = {
      users: {
        user1: {
          username: "user1",
          uid: 1001,
          primary_group: "group1",
          additional_groups: ["group3"],
          shell: "/bin/bash",
        },
        user2: {
          username: "user2",
          uid: 1002,
          primary_group: "group2",
          additional_groups: ["group3"],
          shell: "/bin/bash",
        },
      },
      passwords: {
        user1: "$6$random_salt$encrypted_password1",
        user2: "$6$random_salt$encrypted_password2",
      },
      groups: {
        group1: {
          groupname: "group1",
          gid: 1001,
          users: ["user1"],
        },
        group2: {
          groupname: "group2",
          gid: 1002,
          users: ["user2"],
        },
        group3: {
          groupname: "group3",
          gid: 1003,
          users: ["user1", "user2"],
        },
      },
      lingerStates: {
        user1: true,
        user2: false,
      }
    };

    const result = await getExistingDirectory();
    expect(result).toEqual(expectedData);
  });

  // Test case: Mismatch between user and password lists
  test("should throw an error when user and password lists don't match up", async () => {
    // Mock the readFile function
    jest.spyOn(fsPromises, "readFile").mockImplementation((path) => {
      if (path === "/etc/passwd") {
        return Promise.resolve("user1:x:1001:1001:User 1:/home/user1:/bin/bash");
      } if (path === "/etc/shadow") {
        return Promise.resolve("user1:$6$random_salt$encrypted_password1\nuser2:$6$random_salt$encrypted_password2");
      } if (path === "/etc/group") {
        return Promise.resolve("group1:x:1001:user1");
      }
    });

    await expect(getExistingDirectory()).rejects.toThrow("user and password lists don't match up! users: user1, passwords: user1,user2");
  });
});

describe("objectMap", () => {
  // Test case: Mapping empty object
  test("should return an empty object when mapping an empty object", () => {
    const obj = {};
    const result = objectMap(obj, (value) => value);
    const expected = {};
    expect(result).toEqual(expected);
  });

  // Test case: Mapping object values
  test("should map object values using the provided function", () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = objectMap(obj, (value) => value * 2);
    const expected = { a: 2, b: 4, c: 6 };
    expect(result).toEqual(expected);
  });
});

describe("parseIECSize", () => {
  // Test case: Valid size string without unit
  test("should return the parsed size when given a valid size string without unit", () => {
    const sizeString = "100";
    const expectedSize = 100;
    expect(parseIECSize(sizeString)).toBe(expectedSize);
  });

  // Test case: Valid size string with unit 'k'
  test("should return the parsed size when given a valid size string with unit 'k'", () => {
    const sizeString = "10k";
    const expectedSize = 10240;
    expect(parseIECSize(sizeString)).toBe(expectedSize);
  });

  // Test case: Valid size string with unit 'm'
  test("should return the parsed size when given a valid size string with unit 'm'", () => {
    const sizeString = "5m";
    const expectedSize = 5242880;
    expect(parseIECSize(sizeString)).toBe(expectedSize);
  });

  // Test case: Valid size string with unit 'g'
  test("should return the parsed size when given a valid size string with unit 'g'", () => {
    const sizeString = "2g";
    const expectedSize = 2147483648;
    expect(parseIECSize(sizeString)).toBe(expectedSize);
  });

  // Test case: Valid size string with unit 't'
  test("should return the parsed size when given a valid size string with unit 't'", () => {
    const sizeString = "1t";
    const expectedSize = 1099511627776;
    expect(parseIECSize(sizeString)).toBe(expectedSize);
  });

  // Test case: Invalid size string
  test("should throw an error when given an invalid size string", () => {
    const sizeString = "abc";
    expect(() => parseIECSize(sizeString)).toThrow("Invalid size string: abc");
  });
});