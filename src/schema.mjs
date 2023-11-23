import Ajv from 'ajv';

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
    user_ssh_key_base_dir: { type: "string", description: "Base directory for user SSH keys.", default: "/home" },
  },
  required: ["users", "groups"],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });

export const validateConfig = ajv.compile(configSchema);
