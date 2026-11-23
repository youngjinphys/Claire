// Git's repository-local environment overrides cwd, including for plumbing
// commands. Keep normal repository configuration and linked-worktree discovery,
// but do not inherit a different repository, object store, or inline config.
const ROUTING_VARIABLES = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_SUPER_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_REFERENCE_BACKEND', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
]);

export function gitEnvironmentForCwd(source = process.env, { configFile } = {}) {
  if (configFile !== undefined && (typeof configFile !== 'string' || !configFile)) {
    throw new Error('INVALID_GIT_CONFIG_CONTEXT');
  }
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => {
    // Windows environment keys are case-insensitive, including explicit env
    // objects passed to child_process. Remove every spelling before overriding.
    const name = key.toUpperCase();
    if (configFile !== undefined && name.startsWith('GIT_')) return false;
    return !ROUTING_VARIABLES.has(name) && !/^GIT_CONFIG_(?:KEY|VALUE)_/u.test(name);
  }));
  if (configFile !== undefined) {
    // Synthetic histories use an owned empty file instead of changing HOME or
    // reading user/system configuration. A second normal sanitization keeps it.
    env.GIT_CONFIG_GLOBAL = configFile;
    env.GIT_CONFIG_SYSTEM = configFile;
    env.GIT_CONFIG_NOSYSTEM = '1';
  }
  return env;
}
