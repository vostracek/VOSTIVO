const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// pnpm workspace support: workspace packages (@vostivo/domain, @vostivo/
// contracts) plus their own dependencies (e.g. packages/domain's `uuidv7`)
// are symlinked into pnpm's content-addressable store rather than copied,
// at every level — not just the top-level workspace symlink. Metro's
// default resolver does not follow nested symlinks, so it can locate
// `packages/domain/dist/id-generator.js` but not the `uuidv7` symlink
// inside `packages/domain/node_modules`. See Expo's pnpm monorepo guide.
config.watchFolders = [workspaceRoot];
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
