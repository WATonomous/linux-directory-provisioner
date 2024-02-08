import Ajv from 'ajv';

const quotaSpec = {
  type: "object",
  properties: {
    path: {
      description: "Path to apply quota to. Must be a valid mountpoint.",
      type: "string",
    },
    bytes_soft_limit: {
      description:
        "Soft limit in bytes. Set to `0` to disable this limit. Supports the following suffixes for readability: `Ki` (multiples of 2^10), `Mi` (multiples of 2^20), `Gi` (multiples of 2^30).",
      type: "string",
      pattern: "^[0-9]+(Ki|Mi|Gi)?$",
      default: "0",
    },
    bytes_hard_limit: {
      description:
        "Hard limit in bytes. Set to `0` to disable this limit. Supports the following suffixes for readability: `Ki` (multiples of 2^10), `Mi` (multiples of 2^20), `Gi` (multiples of 2^30).",
      type: "string",
      pattern: "^[0-9]+(Ki|Mi|Gi)?$",
      default: "0",
    },
    inodes_soft_limit: {
      type: "string",
      description:
        "Soft limit in inodes. Set to `0` to disable this limit. Supports the following suffixes for readability: `k` (multiples of 10^3), `m` (multiples of 10^6), `g` (multiples of 10^9), `t` (multiples of 10^12).",
      pattern: "^[0-9]+(k|m|g|t)?$",
      default: "0",
    },
    inodes_hard_limit: {
      type: "string",
      description:
        "Hard limit in inodes. Set to `0` to disable this limit. Supports the following suffixes for readability: `k` (multiples of 10^3), `m` (multiples of 10^6), `g` (multiples of 10^9), `t` (multiples of 10^12).",
      pattern: "^[0-9]+(k|m|g|t)?$",
      default: "0",
    },
  },
  additionalProperties: false,
};

const userSchema = {
  type: "object",
  properties: {
    username: { type: "string" },
    password: { type: "string" },
    update_password: { enum: ["always", "on_create"] },
    uid: { type: "number" },
    primary_group: { type: "string" },
    additional_groups: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      default: [],
    },
    shell: { type: "string", default: "/bin/bash" },
    ssh_authorized_keys: { type: "array", items: { type: "string" }, default: [] },
    linger: { type: "boolean", default: false },
    disk_quota: {
      type: "array",
      items: quotaSpec,
      default: [],
    },
  },
  required: ["username", "password", "update_password", "uid", "primary_group"],
  additionalProperties: false,
};

const groupSchema = {
  type: "object",
  properties: {
    groupname: { type: "string" },
    gid: { type: "number" },
  },
  required: ["groupname", "gid"],
  additionalProperties: false,
};

export const configSchema = {
  type: "object",
  properties: {
    users: { type: "array", items: userSchema },
    groups: { type: "array", items: groupSchema },
    managed_uid_range: {
      type: "array",
      description:
        "Range of UIDs that are managed by this script. Users with UIDs in this range will be deleted if they are not in the config.",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
    managed_gid_range: {
      type: "array",
      description:
        "Range of GIDs that are managed by this script. Groups with GIDs in this range will be deleted if they are not in the config.",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
    user_ssh_key_base_dir: {
      type: "string",
      description: "Base directory for user SSH keys. Supports templating with %u (username) and %U (uid)",
      default: "/home/%u/.ssh",
    },
    use_strict_ssh_key_dir_permissions: {
      type: "boolean",
      description: "If true, the provisioner will manage the SSH key directory permissions such that the user can read/execute the directory, but not write to the directory.",
      default: false,
    },
    // XFS default quota can be set using `sudo xfs_quota <path> -x -c "limit -d bsoft=<bsoft> bhard=<bhard> isoft=<isoft> ihard=<ihard>"`
    xfs_default_user_quota: {
      type: "array",
      items: quotaSpec,
      default: [],
    },
  },
  required: ["users", "groups", "managed_uid_range", "managed_gid_range"],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });

export const validateConfig = ajv.compile(configSchema);
