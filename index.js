// Alchemy Factory Vortex Extension
//
//
// Installers
//
// - UE4SS: the loader (dwmapi.dll or xinput1_3.dll) beside the executable, the rest in
//   Binaries/Win64/ue4ss/. A mod bundled with UE4SS does not install UE4SS.
// - the game folder's layout (AlchemyFactory/...): as is, unless only containers in
//   Content/Paks (those install as containers).
// - a UE4SS mod (a folder with Scripts/main.lua or dlls/main.dll): to ue4ss/Mods/<name>/ plus an
//   enabled.txt. Shared Lua modules (shared/<name>/) to ue4ss/Mods/shared/<name>/.
// - containers (.pak, .utoc, .ucas, .sig): to Content/Paks/~mods/, or Content/Paks/LogicMods/
//   from a LogicMods folder.
// - save games and Cheat Engine tables: refused for now.
// UE4SS gets a mod type of its own; every other mod is of Vortex's default type, the game folder (see
// Mod Types). UE4SS's own files in a mod archive are left out. FOMODs are left to Vortex's installer.
//
//
// UE4SS
//
// UE4SS is installed when the game is first managed, or when the player turns Autoinstall UE4SS on.
// Overwriting an existing UE4SS requires player permission the first time. Removing UE4SS turns the
// setting off. A mod that needs UE4SS then raises a warning whose Fix installs it.
//
//
// Vortex
//
// Vortex Instructions (IInstruction) are documented in the vortex-api typings.
// https://github.com/Nexus-Mods/vortex-api/blob/master/lib/api.d.ts
// This extension uses the Instruction types: copy, generatefile (for enabled.txt), attribute (metadata,
// bundled-UE4SS flag and installerChoices) and setmodtype.
// Vortex doesn't merge table changes, so container mods changing the same table will overwrite each other.
// The plan is to create a shared library which allows changing tables easily via Lua at runtime.

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { createAction } = require('redux-act');
const { actions, fs, log, selectors, Toggle, util } = require('vortex-api');

const GAME_ID = 'alchemyfactory';
const STEAM_APP_ID = '3669570';
const EXECUTABLE = 'AlchemyFactory.exe';
const SHIPPING_EXECUTABLE = path.join(
  'AlchemyFactory', 'Binaries', 'Win64', 'AlchemyFactory-Win64-Shipping.exe');

const BINARIES = path.join('AlchemyFactory', 'Binaries', 'Win64');
const UE4SS_FOLDER = path.join(BINARIES, 'ue4ss');
const UE4SS_MODS = path.join(UE4SS_FOLDER, 'Mods');
const PAKS = path.join('AlchemyFactory', 'Content', 'Paks');
const MODS_PAKS = path.join(PAKS, '~mods');
const LOGIC_MODS = path.join(PAKS, 'LogicMods');

const CONTAINER_EXTENSIONS = ['.pak', '.utoc', '.ucas', '.sig'];
const UE4SS_LOADERS = ['dwmapi.dll', 'xinput1_3.dll'];
const UE4SS_DLL_PATHS = [path.join(UE4SS_FOLDER, 'UE4SS.dll'), path.join(BINARIES, 'UE4SS.dll')];
const UE4SS_BUILT_IN_MODS = ['bpml_genericfunctions', 'bpmodloadermod', 'cheatmanagerenablermod',
  'consolecommandsmod', 'consoleenablermod', 'keybinds', 'linetracemod', 'splitscreenmod'];
const UE4SS_BUILT_IN_LIBRARIES = ['uehelpers'];
// Manually installed UE4SS files that Vortex's UE4SS doesn't replace. They would still load the old
// UE4SS, so they're renamed while Vortex's is deployed.
const OUTSIDE_UE4SS_FILES = [path.join(BINARIES, 'UE4SS.dll'), path.join(BINARIES, 'xinput1_3.dll')];
// Vortex's suffix for the files its deployments replace.
const BACKUP_TAG = '.vortex_backup';

// The pinned UE4SS build, 1181. It fixes a soft object pointer crash in UE 5.3+, and C++ mods are built
// against it.
const UE4SS = {
  version: 'v3.0.1-1181-g83330635',
  zip: 'UE4SS_v3.0.1-1181-g83330635.zip',
  sha256: 'b9a166a756605b21058a64cde93bcaab1a855dba3553e5c7e6ce0fa8fdfad7b9',
  dllSha256: 'ce5e3c46a920cc00b2817ac61e438c9162830290379d0b5b9c4dfc2b29459290',
  sources: [
    'https://github.com/UE4SS-RE/RE-UE4SS/releases/download/experimental/UE4SS_v3.0.1-1181-g83330635.zip',
  ],
  limit: 64 << 20,
};

const PINNED_ATTRIBUTES = {
  customFileName: 'UE4SS',
  version: UE4SS.version.replace(/^v/, ''),
  author: 'UE4SS-RE',
  source: 'website',
  url: 'https://github.com/UE4SS-RE/RE-UE4SS',
  description: 'Loads script mods.',
};

// Mod Types

// UE4SS has a mod type of its own, deployed into Binaries/Win64 (its files are staged relative to
// that), so the extension can find it. Every other mod is of Vortex's default type, the game folder,
// staged as laid out from it. Vortex deploys each type in a pass of its own, with its own manifest, so
// two types deploying the same file raise its External Changes dialog on every deploy. One type for
// mods makes two mods with the same file an ordinary conflict, and the installers keep UE4SS's own
// files out of mods (see `isUe4ssFile`).
const UE4SS_TYPE = 'alchemyfactory-ue4ss';

// Mod Attributes

const METADATA = 'alchemyFactoryMetadata';
const NAME = 'alchemyFactoryName';
// Whether a mod came with UE4SS, or with UE4SS's own files, which were left out (the player is told).
const BUNDLED_UE4SS = 'alchemyFactoryBundledUe4ss';
// Whether a mod needs UE4SS (files in ue4ss/Mods/ or Content/Paks/LogicMods/), set by the installers.
const NEEDS_UE4SS = 'alchemyFactoryNeedsUe4ss';
// Used for reinstalls and collections.
const FOLDER_CHOICE = 'alchemyfactory-folders';
// Nexus Mods' only category for the game.
const CATEGORY = 'Miscellaneous';
// The source Vortex gives a download when its lookup finds the archive but not on any site. A local
// archive can get it, depending on whether the archive's MD5 is ready when Vortex looks it up.
const UNKNOWN_SOURCE = 'unknown';

// Notifications

const NOTIFICATION_INSTALLING = 'alchemyfactory-installing-ue4ss';
const NOTIFICATION_REMOVED = 'alchemyfactory-ue4ss-removed';
const NOTIFICATION_MANAGE = 'alchemyfactory-ue4ss-manage';
const NOTIFICATION_LEFT_ALONE = 'alchemyfactory-ue4ss-left-alone';
const NOTIFICATION_OUTSIDE = 'alchemyfactory-ue4ss-outside';
const NOTIFICATION_OUTSIDE_OTHER_BUILD = 'alchemyfactory-ue4ss-outside-other-build';
// Some notifications need to be dismissed when switching to managing another game.
const NOTIFICATIONS_ABOUT_UE4SS = [NOTIFICATION_REMOVED, NOTIFICATION_MANAGE,
  NOTIFICATION_LEFT_ALONE, NOTIFICATION_OUTSIDE, NOTIFICATION_OUTSIDE_OTHER_BUILD];

// Checks
// Checks are run when the game is managed and as mods are installed or enabled.

const CHECK_UE4SS_NEEDED = 'alchemyfactory-ue4ss-needed';
const CHECK_UE4SS_BUILD = 'alchemyfactory-ue4ss-build';
const CHECK_REQUIREMENTS = 'alchemyfactory-requirements';
const CHECK_EVENTS = ['gamemode-activated', 'profile-did-change', 'mod-installed', 'mod-activated'];

// Download import timeout in ms.
const IMPORT_TIMEOUT = 60000;
// File types refused by the extension, with the message shown.
const UNPLACEABLE = {
  '.sav': 'Save games aren\'t mods. Copy them to %LOCALAPPDATA%\\AlchemyFactory\\Saved\\SaveGames.',
  '.ct': 'Cheat Engine tables aren\'t mods. Open them in Cheat Engine.',
};
const DOCUMENT_EXTENSIONS = ['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg'];

// Settings

// The Autoinstall UE4SS setting:
// - Install UE4SS automatically.
// - A notification asks permission first when UE4SS is installed outside Vortex. Answering sets
//   `autoinstallUe4ssChosen`, so it isn't asked again.
// - Uninstalling UE4SS turns the setting off.
const SETTINGS = ['settings', 'alchemyFactory'];
const setAutoinstallUe4ss = createAction('ALCHEMYFACTORY_SET_AUTOINSTALL_UE4SS',
  (enabled) => ({ enabled }));
const settingsReducer = {
  reducers: {
    [setAutoinstallUe4ss]: (state, payload) =>
      ({ ...state, autoinstallUe4ss: payload.enabled, autoinstallUe4ssChosen: true }),
  },
  defaults: { autoinstallUe4ss: true, autoinstallUe4ssChosen: false },
};
const autoinstallsUe4ss = (state) => util.getSafe(state, [...SETTINGS, 'autoinstallUe4ss'], true);
const choseAutoinstall = (state) =>
  util.getSafe(state, [...SETTINGS, 'autoinstallUe4ssChosen'], false);

// The settings page, under Game settings, Mods.
function SettingsPage() {
  const React = require('react');
  const { ControlLabel, FormGroup, HelpBlock } = require('react-bootstrap');
  const { useDispatch, useSelector } = require('react-redux');
  const enabled = useSelector(autoinstallsUe4ss);
  const dispatch = useDispatch();
  return React.createElement('form', null,
    React.createElement(FormGroup, { controlId: 'alchemyfactory-autoinstall-ue4ss' },
      React.createElement(ControlLabel, null, 'Alchemy Factory'),
      React.createElement(Toggle, {
        checked: enabled,
        onToggle: (value) => dispatch(setAutoinstallUe4ss(value)),
      }, 'Autoinstall UE4SS'),
      React.createElement(HelpBlock, null,
        'Script mods need UE4SS. Replaces an existing UE4SS.')));
}

// Archive Paths

const segments = (file) => file.split(/[\\/]/).filter((segment) => segment !== '');
const isFolder = (file) => file.endsWith('/') || file.endsWith('\\');
const lower = (text) => text.toLowerCase();
const startsWith = (parts, prefix) =>
  prefix.length <= parts.length && prefix.every((part, index) => lower(parts[index]) === lower(part));
// An archive with an FOMOD installer.
const hasFomod = (files) => files.some((file) => {
  const parts = segments(file);
  return parts.length >= 2 && lower(parts[parts.length - 1]) === 'moduleconfig.xml'
    && lower(parts[parts.length - 2]) === 'fomod';
});

// The index of the "LogicMods" folder in a path, else -1.
function logicModsIndex(parts) {
  const logic = parts.findIndex((part) => lower(part) === 'logicmods');
  return logic < parts.length - 1 ? logic : -1;
}

// Content/Paks/LogicMods/<below that folder>, or Content/Paks/~mods/<name>.
function containerDestination(parts) {
  const logic = logicModsIndex(parts);
  if (logic !== -1) {
    return path.join(LOGIC_MODS, ...parts.slice(logic + 1));
  }
  return path.join(MODS_PAKS, parts[parts.length - 1]);
}

const isContainer = (parts) =>
  CONTAINER_EXTENSIONS.includes(lower(path.extname(parts[parts.length - 1])));

// The index of the "AlchemyFactory" folder in a path (.../AlchemyFactory/Content/... or
// .../AlchemyFactory/Binaries/...), else -1.
function gameFolderIndex(parts) {
  return parts.findIndex((part, index) =>
    lower(part) === 'alchemyfactory'
    && ['content', 'binaries'].includes(lower(parts[index + 1] || '')));
}

// Folders holding a UE4SS mod (those with Scripts/main.lua or dlls/main.dll).
function ue4ssModFolders(files) {
  const found = [];
  for (const file of files) {
    const parts = segments(file);
    const tail = parts.slice(-2).map(lower).join('/');
    if (tail === 'scripts/main.lua' || tail === 'dlls/main.dll') {
      const folder = parts.slice(0, -2);
      if (!found.some((other) => other.join('/') === folder.join('/'))) {
        found.push(folder);
      }
    }
  }
  return found;
}

// The index of the "shared" folder in a path (.../shared/<module>/...), else -1.
function sharedIndex(parts) {
  const shared = parts.findIndex((part) => lower(part) === 'shared');
  return shared < parts.length - 2 ? shared : -1;
}

// Get a mod's name from its staging folder.
// <name>-<mod>-<version>-<file>-<time> becomes <name>.
// Speed-X-2-<mod>-<version>-<file>-<time> becomes SpeedX.
function nameFromArchive(destinationPath) {
  // Regex "(-\d+)+$":
  // - match '-' then one or more digits.
  // - match that one or more times.
  // - must be at the end of the string.
  const base = path.basename(destinationPath, '.installing').replace(/(-\d+)+$/, '');
  // Regex "[^A-Za-z0-9_]" matches all characters that are NOT letters, numbers or underscores.
  return base.replace(/[^A-Za-z0-9_]/g, '') || 'Mod';
}

const copy = (source, destination) => ({ type: 'copy', source, destination });

const isFile = (instruction) => ['copy', 'generatefile'].includes(instruction.type);

// UE4SS's instructions: each file's destination made relative to its type's folder (Binaries/Win64),
// and the type.
function asUe4ss(instructions) {
  for (const instruction of instructions.filter(isFile)) {
    instruction.destination = path.join(
      ...segments(instruction.destination).slice(segments(BINARIES).length));
  }
  return [...instructions, { type: 'setmodtype', value: UE4SS_TYPE }];
}

// A mod's instructions (Vortex's default type, so each file's destination is from the game folder),
// recording whether the mod needs UE4SS (`NEEDS_UE4SS`) and, when `leftOut` UE4SS files were, that
// (`BUNDLED_UE4SS`). An archive of only UE4SS's own files is refused, as save games are (see
// `installUnplaceable`).
function asMod(instructions, leftOut = 0) {
  const files = instructions.filter(isFile);
  if (files.length === 0 && leftOut > 0) {
    throw new util.SetupError('These are UE4SS\'s own files. Vortex installs UE4SS itself.');
  }
  const needsUe4ss = files.some((instruction) => [UE4SS_MODS, LOGIC_MODS].some((folder) =>
    startsWith(segments(instruction.destination), segments(folder))));
  return [
    ...instructions,
    { type: 'attribute', key: NEEDS_UE4SS, value: needsUe4ss },
    ...(leftOut > 0 ? [{ type: 'attribute', key: BUNDLED_UE4SS, value: true }] : []),
  ];
}

// The game's own folders, longest first.
const GAME_FOLDERS = [UE4SS_MODS, UE4SS_FOLDER, BINARIES, MODS_PAKS, LOGIC_MODS, PAKS, 'AlchemyFactory'];

// A path from the game folder with the game's own folders written as the game has them (an archive may
// have them in another case).
function inGameCase(relative) {
  for (const folder of GAME_FOLDERS) {
    const parts = segments(folder);
    if (startsWith(relative, parts)) {
      return [...parts, ...relative.slice(parts.length)];
    }
  }
  return relative;
}

// Multi-Folder Containers

// Collect all folders to detect naming collisions and avoid installing
// multiple versions of the same mod.
function containerFolders(files) {
  const folders = new Map();
  for (const file of files) {
    const parts = segments(file);
    const folder = parts.slice(0, -1);
    const key = folder.map(lower).join('/');
    const entry = folders.get(key) || { key, folder: folder.join('/'), names: [], files: [] };
    entry.names.push(parts[parts.length - 1]);
    entry.files.push(file);
    folders.set(key, entry);
  }
  return [...folders.values()].sort((a, b) =>
    segments(a.folder).length - segments(b.folder).length || a.key.localeCompare(b.key));
}

// Choose which folders to install:
// - 0 or 1 folders: all folders.
// - a recorded choice: the folders from the recorded choice.
// - multiple versions: folders which share file names are different versions of the same mod.
//   The player is asked to choose a version (default is the first version).
// - multiple parts: if not multiple versions, then multiple parts. The player is asked to choose
//   which parts to install (default is all parts).
// The default option is chosen if unattended.
async function chooseContainerFolders(api, folders, choices, unattended) {
  if (folders.length <= 1) {
    return folders;
  }
  if (choices?.type === FOLDER_CHOICE && Array.isArray(choices.folders)) {
    const chosen = folders.filter((entry) => choices.folders.includes(entry.key));
    if (chosen.length > 0) {
      return chosen;
    }
  }
  const names = folders.flatMap((entry) => entry.names.map(lower));
  const onlyOne = new Set(names).size < names.length;
  if (unattended || api === undefined) {
    return onlyOne ? folders.slice(0, 1) : folders;
  }
  const controls = folders.map((entry, index) => ({
    id: String(index),
    text: entry.folder || '(top folder)',
    subText: entry.names.join(', '),
    value: onlyOne ? index === 0 : true,
  }));
  const result = await api.showDialog('question', 'Choose what to install', {
    text: onlyOne
      ? 'This mod comes in several versions. Choose one:'
      : 'This mod has several parts. Untick any you don\'t want:',
    [onlyOne ? 'choices' : 'checkboxes']: controls,
  }, [{ label: 'Cancel' }, { label: 'Install' }]);
  const chosen = result.action === 'Install'
    ? folders.filter((entry, index) => result.input?.[String(index)] === true)
    : [];
  if (chosen.length === 0) {
    throw new util.UserCanceled();
  }
  return chosen;
}

// The folder choices of mods being replaced, by mod id (see `onWillRemoveMods`). Vortex passes a
// replaced mod's `installerChoices` back only for archives from Nexus Mods, so a reinstalled local
// archive would ask again.
const REPLACED_CHOICES = new Map();

// The folder choice of the mod being installed to `destinationPath`, if it's replacing one. Vortex
// installs into "<staging>/<mod id>.installing", and a replacement keeps the mod's id. Each choice is
// used once, so a later fresh install asks again.
function replacedChoices(destinationPath) {
  if (destinationPath === undefined) {
    return undefined;
  }
  const modId = path.basename(destinationPath).replace(/\.installing$/, '');
  const choices = REPLACED_CHOICES.get(modId);
  REPLACED_CHOICES.delete(modId);
  return choices;
}

// Copy instructions for the containers to install, plus the folder choice (when there were several
// folders).
async function containerInstructions(files, { api, choices, unattended } = {}) {
  const logic = files.filter((file) => logicModsIndex(segments(file)) !== -1);
  const folders = containerFolders(files.filter((file) => !logic.includes(file)));
  const chosen = await chooseContainerFolders(api, folders, choices, unattended);
  const instructions = [...logic, ...chosen.flatMap((entry) => entry.files)]
    .map((file) => copy(file, containerDestination(segments(file))));
  if (folders.length > 1) {
    instructions.push({
      type: 'attribute',
      key: 'installerChoices',
      value: { type: FOLDER_CHOICE, folders: chosen.map((entry) => entry.key) },
    });
  }
  return instructions;
}

// Mod Archives

// The mods a manifest.json's `dependencies` names, each written "<team>-<name>-<version>".
// UE4SS is left out, as the UE4SS checks cover it (see `checkUe4ssNeeded`).
function requirementsOf(dependencies) {
  if (!Array.isArray(dependencies)) {
    return [];
  }
  return dependencies
    .filter((dependency) => typeof dependency === 'string')
    .map((dependency) => dependency.trim().split('-'))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({ name: parts.slice(1, -1).join('-'), version: parts[parts.length - 1] }))
    .filter((requirement) => requirement.name !== '' && !lower(requirement.name).includes('ue4ss'));
}

// Read the mod's manifest.json (the shallowest one).
// Reads name, title, version, description, url, the UE4SS build it needs (`ue4ss_version`) and the
// mods it requires (see `requirementsOf`).
// Returns {} if no manifest.json was found, no `version_number` was set, or the json was malformed.
async function readMetadata(files, destinationPath) {
  const candidates = files
    .filter((file) => !isFolder(file) && lower(path.basename(file)) === 'manifest.json')
    .sort((a, b) => segments(a).length - segments(b).length);
  for (const file of candidates) {
    try {
      const text = await fs.readFileAsync(path.join(destinationPath, file), 'utf8');
      const json = JSON.parse(text.trim());
      if (typeof json.version_number !== 'string') {
        continue;
      }
      const metadata = {
        // The name other mods' manifests use to require this one.
        name: json.name,
        title: typeof json.name === 'string' ? json.name.replace(/_/g, ' ') : undefined,
        version: json.version_number,
        description: json.description,
        url: json.website_url,
        // The UE4SS build a C++ mod was built against, the oldest it runs on (see `ue4ssNeeded`).
        ue4ss: ue4ssBuild(json.ue4ss_version) === undefined ? undefined : json.ue4ss_version,
      };
      const found = Object.fromEntries(Object.entries(metadata)
        .filter(([, value]) => typeof value === 'string' && value.trim() !== ''));
      const requirements = requirementsOf(json.dependencies);
      return requirements.length > 0 ? { ...found, requirements } : found;
    } catch (error) {
      log('debug', 'couldn\'t read a mod\'s metadata', { file, error: error.message });
    }
  }
  return {};
}

// If metadata is found, return a Vortex Instruction to store said metadata under the key `METADATA`.
async function metadataInstructions(files, destinationPath) {
  const metadata = await readMetadata(files, destinationPath);
  return Object.keys(metadata).length > 0 ? [{ type: 'attribute', key: METADATA, value: metadata }] : [];
}

// Installers

// An archive with a UE4SS.dll.
async function testUe4ss(files, gameId) {
  const supported = gameId === GAME_ID && !hasFomod(files)
    && files.some((file) => lower(path.basename(file)) === 'ue4ss.dll');
  return { supported, requiredFiles: [] };
}

// UE4SS file locations:
// - dllFolder: UE4SS.dll's folder.
// - top: the loader's (dwmapi.dll or xinput1_3.dll) folder. dllFolder, or 1 folder up if dllFolder ends
//   in 'ue4ss/' (the UE4SS 3 layout).
function ue4ssLayout(files) {
  const dll = files.find((file) => lower(path.basename(file)) === 'ue4ss.dll');
  const dllFolder = segments(dll).slice(0, -1);
  const nested = dllFolder.length > 0 && lower(dllFolder[dllFolder.length - 1]) === 'ue4ss';
  return { dllFolder, top: nested ? dllFolder.slice(0, -1) : dllFolder };
}

// Whether a file belongs to UE4SS:
// - the UE4SS loader in `top` (dwmapi.dll or xinput1_3.dll).
// - anything in `dllFolder` except:
//   - containers (.pak, .utoc, .ucas, .sig).
//   - Mods/<mod>/, excluding built-in mods.
//   - Mods/shared/<library>/, excluding built-in libraries.
function belongsToUe4ss(parts, { dllFolder, top }) {
  if (parts.length === top.length + 1 && startsWith(parts, top)
      && UE4SS_LOADERS.includes(lower(parts[parts.length - 1]))) {
    return true;
  }
  if (!startsWith(parts, dllFolder) || parts.length === dllFolder.length || isContainer(parts)) {
    return false;
  }
  const below = parts.slice(dllFolder.length).map(lower);
  if (below[0] !== 'mods' || below.length < 3) {
    return true;
  }
  return below[1] === 'shared'
    ? below.length < 4 || UE4SS_BUILT_IN_LIBRARIES.includes(below[2])
    : UE4SS_BUILT_IN_MODS.includes(below[1]);
}

// Whether a path from the game folder (AlchemyFactory/...) is one of UE4SS's own files, which its mod
// type deploys (see `belongsToUe4ss`): its loader beside the executable, and anything in ue4ss/ but
// mods and libraries of its own. A mod's copy is left out, as two types deploying the same file raise
// Vortex's External Changes dialog on every deploy (see Mod Types).
const isUe4ssFile = (relative) =>
  belongsToUe4ss(relative, { dllFolder: segments(UE4SS_FOLDER), top: segments(BINARIES) });

// Whether a path from the game folder is UE4SS's own mod list (Mods/mods.txt or mods.json). Vortex's
// UE4SS replaces it, so a mod's is left out without a word (its mods get an enabled.txt instead).
function isUe4ssModList(relative) {
  const mods = segments(UE4SS_MODS);
  return relative.length === mods.length + 1 && startsWith(relative, mods)
    && ['mods.txt', 'mods.json'].includes(lower(relative[relative.length - 1]));
}

// Get a list of the mods bundled with UE4SS. These are files which don't belong to UE4SS and are in a
// valid mod location:
// - containers (.pak, .utoc, .ucas, .sig) anywhere.
// - `layout.dllFolder`/Mods/<mod>/..., excluding UE4SS built-in mods.
// - AlchemyFactory/Content/... or AlchemyFactory/Binaries/...
function bundledMods(files) {
  const layout = ue4ssLayout(files);
  return files.filter((file) => {
    const parts = segments(file);
    return !isFolder(file) && !belongsToUe4ss(parts, layout)
      && (startsWith(parts, layout.dllFolder) || isContainer(parts) || gameFolderIndex(parts) !== -1);
  });
}

// Install UE4SS, laid out as released (dwmapi.dll, ue4ss/...) or flat.
// - no version is set, as the archive may not be the pinned build (`installPinned` sets the pinned
//   build's version, Nexus Mods gives its downloads theirs).
// - an archive bundling mods installs as those mods, without its UE4SS (the pinned build serves them).
// `options` is as for `installContainers` (see its comment).
async function installUe4ss(files, destinationPath, options) {
  const mods = bundledMods(files);
  if (mods.length > 0) {
    // Include the manifests for metadata (they're never copied).
    const manifests = files.filter((file) =>
      lower(path.basename(file)) === 'manifest.json' && !mods.includes(file));
    // Use the installer that would take the mods on their own.
    let install = installContainers;
    if ((await testGameLayout(mods, GAME_ID)).supported) {
      install = installGameLayout;
    } else if ((await testUe4ssMod(mods, GAME_ID)).supported) {
      install = installUe4ssMod;
    }
    const result = await install([...mods, ...manifests], destinationPath, options);
    result.instructions.push({ type: 'attribute', key: BUNDLED_UE4SS, value: true });
    return result;
  }
  const { dllFolder, top } = ue4ssLayout(files);
  const instructions = [];
  for (const file of files.filter((file) => !isFolder(file))) {
    const parts = segments(file);
    const name = lower(parts[parts.length - 1]);
    if (parts.length === top.length + 1 && startsWith(parts, top) && UE4SS_LOADERS.includes(name)) {
      instructions.push(copy(file, path.join(BINARIES, parts[parts.length - 1])));
    } else if (startsWith(parts, dllFolder) && parts.length > dllFolder.length) {
      instructions.push(copy(file, path.join(UE4SS_FOLDER, ...parts.slice(dllFolder.length))));
    }
  }
  return { instructions: asUe4ss(instructions) };
}

// Files in the game folder's layout (AlchemyFactory/Content/... or AlchemyFactory/Binaries/...).
// Not containers alone in Content/Paks (Max Yield's layout), those go to ~mods with the other mods.
async function testGameLayout(files, gameId) {
  const gameFiles = files.filter((file) => !isFolder(file)).map(segments)
    .filter((parts) => gameFolderIndex(parts) !== -1);
  const containersAlone = gameFiles.every((parts) =>
    isContainer(parts) && startsWith(parts.slice(gameFolderIndex(parts)), segments(PAKS)));
  const supported = gameId === GAME_ID && !hasFomod(files) && gameFiles.length > 0 && !containersAlone;
  return { supported, requiredFiles: [] };
}

// Install the game files as laid out, the game's own folders in their case. A README, icon or manifest
// beside them is left out.
// - an enabled.txt is generated for each UE4SS mod lacking one.
// - UE4SS's own files are left out (see `isUe4ssFile`), its mod list without a word.
async function installGameLayout(files, destinationPath) {
  const instructions = await metadataInstructions(files, destinationPath);
  const placed = [];
  let leftOut = 0;
  for (const file of files.filter((file) => !isFolder(file))) {
    const parts = segments(file);
    const index = gameFolderIndex(parts);
    if (index === -1) {
      continue;
    }
    const relative = inGameCase(parts.slice(index));
    if (isUe4ssFile(relative)) {
      leftOut += isUe4ssModList(relative) ? 0 : 1;
      continue;
    }
    instructions.push(copy(file, path.join(...relative)));
    placed.push(relative);
  }
  instructions.push(...enabledFiles(placed));
  return { instructions: asMod(instructions, leftOut) };
}

// Generate an enabled.txt for each UE4SS mod among `placed` (paths in the game folder) lacking one.
// Mods/shared/ is skipped (libraries aren't mods).
function enabledFiles(placed) {
  const modsDepth = segments(UE4SS_MODS).length;
  const mods = new Map();
  for (const relative of placed) {
    if (!startsWith(relative, segments(UE4SS_MODS)) || relative.length < modsDepth + 2) {
      continue;
    }
    const mod = relative[modsDepth];
    if (lower(mod) === 'shared') {
      continue;
    }
    const entry = mods.get(lower(mod)) || { name: mod, enabled: false };
    if (relative.length === modsDepth + 2 && lower(relative[modsDepth + 1]) === 'enabled.txt') {
      entry.enabled = true;
    }
    mods.set(lower(mod), entry);
  }
  return [...mods.values()]
    .filter((mod) => !mod.enabled)
    .map((mod) => ({
      type: 'generatefile', data: '', destination: path.join(UE4SS_MODS, mod.name, 'enabled.txt'),
    }));
}

// A UE4SS mod (a folder with Scripts/main.lua or dlls/main.dll), or shared modules alone (a library).
async function testUe4ssMod(files, gameId) {
  const supported = gameId === GAME_ID && !hasFomod(files) && (ue4ssModFolders(files).length > 0
    || files.some((file) => !isFolder(file) && lower(path.extname(file)) === '.lua'
      && sharedIndex(segments(file)) !== -1));
  return { supported, requiredFiles: [] };
}

// Install UE4SS mods, wherever they are in the archive.
// - each mod to ue4ss/Mods/<folder>, named from the archive if the mod is at the top.
// - shared modules to ue4ss/Mods/shared/.
// - containers as containers (see `containerInstructions`).
// - UE4SS's own mods and libraries are left out (see `isUe4ssFile`).
// `options` is as for `installContainers` (see its comment).
async function installUe4ssMod(files, destinationPath, options) {
  const folders = ue4ssModFolders(files);
  const instructions = await metadataInstructions(files, destinationPath);
  const placed = [];
  const containers = [];
  let leftOut = 0;
  for (const file of files.filter((file) => !isFolder(file))) {
    const parts = segments(file);
    // The game loads containers only from Content/Paks.
    if (isContainer(parts)) {
      containers.push(file);
      continue;
    }
    const shared = sharedIndex(parts);
    // A mod at the top of the archive holds every file, except a shared/ folder beside its Scripts/
    // (that's UE4SS's shared folder).
    const folder = folders.find((candidate) => startsWith(parts, candidate)
      && (candidate.length > 0 || shared !== 0));
    let relative;
    if (folder !== undefined) {
      const name = folder.length > 0 ? folder[folder.length - 1] : nameFromArchive(destinationPath);
      relative = [...segments(UE4SS_MODS), name, ...parts.slice(folder.length)];
    } else if (shared !== -1) {
      relative = [...segments(UE4SS_MODS), 'shared', ...parts.slice(shared + 1)];
    } else {
      continue;
    }
    if (isUe4ssFile(relative)) {
      leftOut += 1;
      continue;
    }
    instructions.push(copy(file, path.join(...relative)));
    placed.push(relative);
  }
  instructions.push(...await containerInstructions(containers, options));
  instructions.push(...enabledFiles(placed));
  return { instructions: asMod(instructions, leftOut) };
}

// Any containers (.pak, .utoc, .ucas, .sig).
async function testContainers(files, gameId) {
  const supported = gameId === GAME_ID && !hasFomod(files)
    && files.some((file) => !isFolder(file) && isContainer(segments(file)));
  return { supported, requiredFiles: [] };
}

// Install containers to ~mods or LogicMods.
// `options` holds the API (to ask the player which folders), Vortex's recorded choices
// (`installerChoices`) and whether installing unattended.
async function installContainers(files, destinationPath, options) {
  const instructions = await metadataInstructions(files, destinationPath);
  instructions.push(...await containerInstructions(
    files.filter((file) => !isFolder(file) && isContainer(segments(file))), options));
  return { instructions: asMod(instructions) };
}

// Save games and Cheat Engine tables (UNPLACEABLE), with documents at most. Vortex's fallback installer
// would copy them into the game folder, where they do nothing.
async function testUnplaceable(files, gameId) {
  const extensions = files.filter((file) => !isFolder(file)).map((file) => lower(path.extname(file)));
  const supported = gameId === GAME_ID
    && extensions.some((extension) => extension in UNPLACEABLE)
    && extensions.every((extension) => extension in UNPLACEABLE || DOCUMENT_EXTENSIONS.includes(extension));
  return { supported, requiredFiles: [] };
}

// Refuse the unplaceable files, saying where they go. Throwing a SetupError makes Vortex show
// "Installation failed" with the message and no report button.
async function installUnplaceable(files) {
  const extensions = new Set(files.map((file) => lower(path.extname(file))));
  const message = Object.keys(UNPLACEABLE)
    .filter((extension) => extensions.has(extension))
    .map((extension) => UNPLACEABLE[extension])
    .join(' ');
  throw new util.SetupError(message);
}

// UE4SS Status

// A mod's install time in ms (0 if unknown).
const installTime = (mod) => {
  const time = Date.parse(mod.attributes?.installTime);
  return Number.isNaN(time) ? 0 : time;
};
const profileOf = (state) => selectors.lastActiveProfileForGame(state, GAME_ID);
const isEnabled = (state, profileId, modId) =>
  util.getSafe(state, ['persistent', 'profiles', profileId, 'modState', modId, 'enabled'], false);

// The UE4SS mods in Vortex, newest first.
function ue4ssMods(state) {
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  return Object.values(mods)
    .filter((mod) => mod.type === UE4SS_TYPE)
    .sort((a, b) => installTime(b) - installTime(a));
}

async function fileExists(file) {
  try {
    await fs.statAsync(file);
    return true;
  } catch (error) {
    return false;
  }
}

// The UE4SS.dll in the game folder (ue4ss/ or Binaries/), if any.
async function gameFolderUe4ss(gamePath) {
  for (const relative of UE4SS_DLL_PATHS) {
    const dll = path.join(gamePath, relative);
    if (await fileExists(dll)) {
      return dll;
    }
  }
  return undefined;
}

// The UE4SS the game has:
// - enabled: a UE4SS mod enabled in Vortex.
// - disabled: Vortex has UE4SS mods but none enabled (the newest is returned).
// - outside: UE4SS installed outside Vortex (its dll is returned).
// - missing: none.
async function ue4ssStatus(state) {
  const profileId = profileOf(state);
  const mods = ue4ssMods(state);
  const enabled = mods.find((mod) => isEnabled(state, profileId, mod.id));
  if (enabled !== undefined) {
    return { kind: 'enabled', mod: enabled };
  }
  if (mods.length > 0) {
    return { kind: 'disabled', mod: mods[0] };
  }
  const gamePath = selectors.discoveryByGame(state, GAME_ID)?.path;
  const dll = gamePath === undefined ? undefined : await gameFolderUe4ss(gamePath);
  return dll === undefined ? { kind: 'missing' } : { kind: 'outside', dll };
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Whether a UE4SS.dll is the pinned build's. Throws if unreadable.
// Results are cached by file size and modification time, as the checks ask whenever mods are
// installed or enabled.
const pinnedDlls = new Map();
async function matchesPinnedBuild(dll) {
  const { size, mtimeMs } = await fs.statAsync(dll);
  const key = `${size} ${mtimeMs}`;
  if (pinnedDlls.get(dll)?.key !== key) {
    pinnedDlls.set(dll, { key, pinned: sha256(await fs.readFileAsync(dll)) === UE4SS.dllSha256 });
  }
  return pinnedDlls.get(dll).pinned;
}

// Whether a UE4SS mod in Vortex is the pinned build, judged by its staged UE4SS.dll.
// Returns undefined if the dll is unreadable.
async function isPinnedBuild(state, mod) {
  const dll = path.join(selectors.installPathForGame(state, GAME_ID), mod.installationPath,
    'ue4ss', 'UE4SS.dll');
  try {
    return await matchesPinnedBuild(dll);
  } catch (error) {
    log('debug', 'couldn\'t read a UE4SS mod\'s UE4SS.dll', { modId: mod.id, error: error.message });
    return undefined;
  }
}

// Pinned UE4SS Install

// GET a url over HTTPS, following up to `redirects` redirects (HTTPS only) and refusing more than
// `limit` bytes.
function download(url, limit, redirects = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Vortex game-alchemyfactory' } },
      (response) => {
        const { statusCode, headers } = response;
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location && redirects > 0) {
          response.resume();
          const next = new URL(headers.location, url).toString();
          if (!next.startsWith('https:')) {
            reject(new Error(`${url} redirects away from HTTPS`));
            return;
          }
          resolve(download(next, limit, redirects - 1));
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`${url}: HTTP ${statusCode}`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) {
            request.destroy(new Error(`${url} is larger than expected`));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      });
    request.on('error', reject);
    request.setTimeout(120000, () => request.destroy(new Error(`${url} timed out`)));
  });
}

// Download the pinned build's zip to Vortex's temp folder, trying each source until one's SHA-256
// matches. Returns the file's path.
async function downloadUe4ss() {
  const failures = [];
  for (const url of UE4SS.sources) {
    try {
      const bytes = await download(url, UE4SS.limit);
      if (sha256(bytes) !== UE4SS.sha256) {
        failures.push(`${url}: not the expected file (its SHA-256 differs)`);
        continue;
      }
      const file = path.join(util.getVortexPath('temp'), UE4SS.zip);
      await fs.writeFileAsync(file, bytes);
      return file;
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`couldn't download UE4SS ${UE4SS.version}:\n${failures.join('\n')}`);
}

// Whether a Vortex download is the pinned build's zip (by file name and game).
const isPinnedDownload = (download) =>
  lower(download?.localPath || '') === lower(UE4SS.zip)
  && [].concat(download?.game || []).includes(GAME_ID);

// The id of the pinned build's download, if Vortex has it (finished).
function ue4ssDownload(state) {
  const downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], {});
  return Object.keys(downloads).find((id) =>
    isPinnedDownload(downloads[id]) && downloads[id].state === 'finished');
}

// An attribute extractor which gives the pinned build's download `PINNED_ATTRIBUTES`.
// Vortex builds an uninstalled download's row with extractors too. A lower priority wins, so this
// extractor (20) beats Nexus Mods' (25 to 150) and loses to a name the player gave (10).
function pinnedDownloadAttributes(input) {
  return Promise.resolve(isPinnedDownload(input?.download) ? PINNED_ATTRIBUTES : {});
}

// Import a file into Vortex's downloads, then remove the file (Vortex copies it).
// Vortex files the download under the active game, and never calls back without one, so this fails
// unless Alchemy Factory is being managed. Imported silently, as the "File imported" notification would
// offer to install it again.
// Returns the download id.
async function importDownload(api, file) {
  if (selectors.activeGameId(api.getState()) !== GAME_ID) {
    throw new util.ProcessCanceled('Alchemy Factory is no longer the game being managed');
  }
  let timer;
  const imported = await Promise.race([
    new Promise((resolve) => api.events.emit('import-downloads', [file], resolve, true)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve([]), IMPORT_TIMEOUT);
    }),
  ]);
  clearTimeout(timer);
  if (imported?.[0] === undefined) {
    throw new Error(`Vortex couldn't add ${file} to its downloads`);
  }
  await fs.removeAsync(file).catch((error) =>
    log('debug', 'couldn\'t remove a downloaded file', { file, error: error.message }));
  return imported[0];
}

// Enable one UE4SS mod, disabling any others (two would both load). Vortex then deploys, if set to.
async function switchTo(api, modId) {
  const state = api.getState();
  const profileId = profileOf(state);
  const others = ue4ssMods(state)
    .filter((mod) => mod.id !== modId && isEnabled(state, profileId, mod.id))
    .map((mod) => mod.id);
  if (others.length > 0) {
    await actions.setModsEnabled(api, profileId, others, false);
  }
  await actions.setModsEnabled(api, profileId, [modId], true);
}

// The install in progress, shared by concurrent calls.
let installing;

// Install the pinned UE4SS and switch to it, from its download if Vortex has it, else downloading it
// now. Concurrent calls share one install.
// Resolves with the mod id, or undefined if it wasn't installed (the player is told, unless they
// canceled).
function installPinnedUe4ss(api) {
  if (installing === undefined) {
    installing = installPinned(api).finally(() => {
      installing = undefined;
    });
  }
  return installing;
}

async function installPinned(api) {
  api.sendNotification({
    id: NOTIFICATION_INSTALLING,
    type: 'activity',
    message: 'Installing UE4SS',
    noDismiss: true,
  });
  try {
    let downloadId = ue4ssDownload(api.getState());
    if (downloadId === undefined) {
      downloadId = await importDownload(api, await downloadUe4ss());
    }
    const modId = await util.toPromise((callback) =>
      api.events.emit('start-install-download', downloadId, true, callback));
    api.store.dispatch(actions.setModAttributes(GAME_ID, modId, PINNED_ATTRIBUTES));
    await switchTo(api, modId);
    return modId;
  } catch (error) {
    if (error instanceof util.ProcessCanceled || error instanceof util.UserCanceled) {
      log('info', 'UE4SS wasn\'t installed', error.message);
    } else {
      api.showErrorNotification('Couldn\'t install UE4SS', error, { allowReport: false });
    }
    return undefined;
  } finally {
    api.dismissNotification(NOTIFICATION_INSTALLING);
  }
}

// Switch to the pinned UE4SS. Uses the one in Vortex if there is one, else installs it now.
async function usePinnedUe4ss(api) {
  const state = api.getState();
  for (const mod of ue4ssMods(state)) {
    if (await isPinnedBuild(state, mod)) {
      await switchTo(api, mod.id);
      return mod.id;
    }
  }
  return installPinnedUe4ss(api);
}

// The mods page's Install UE4SS button, the player letting Vortex manage UE4SS.
// Turns the setting on and installs the pinned build, unless Vortex already has it, or a newer build,
// enabled.
async function installUe4ssAction(api) {
  api.store.dispatch(setAutoinstallUe4ss(true));
  for (const id of [NOTIFICATION_MANAGE, NOTIFICATION_OUTSIDE, NOTIFICATION_OUTSIDE_OTHER_BUILD]) {
    api.dismissNotification(id);
  }
  const state = api.getState();
  const status = await ue4ssStatus(state);
  const newEnough = async (mod) => {
    if (await isPinnedBuild(state, mod) !== false) {
      return true;
    }
    const found = await ue4ssModBuild(state, mod);
    return found !== undefined && compareBuilds(found.build, ue4ssBuild(PINNED_ATTRIBUTES.version)) >= 0;
  };
  if (status.kind === 'enabled' && await newEnough(status.mod)) {
    api.sendNotification({ type: 'info', message: 'UE4SS is already installed', displayMS: 5000 });
  } else {
    await usePinnedUe4ss(api);
  }
}

// Whether a UE4SS.dll is the pinned build's. Returns false if unreadable.
async function isPinnedDll(dll) {
  try {
    return await matchesPinnedBuild(dll);
  } catch (error) {
    log('warn', 'couldn\'t read UE4SS.dll', error.message);
    return false;
  }
}

// Tell the player a UE4SS installed outside Vortex was left alone (it isn't in the mods list).
// Warns if it isn't the pinned build, as C++ mods may not load. Either notification can be hidden for
// good.
async function notifyOutsideUe4ss(api, dll) {
  if (await isPinnedDll(dll)) {
    api.sendNotification({
      id: NOTIFICATION_OUTSIDE,
      type: 'info',
      allowSuppress: true,
      title: 'UE4SS installed outside Vortex',
      message: 'Turning on Autoinstall UE4SS in Game settings and managing UE4SS through Vortex is recommended.',
    });
  } else {
    api.sendNotification({
      id: NOTIFICATION_OUTSIDE_OTHER_BUILD,
      type: 'warning',
      allowSuppress: true,
      title: 'UE4SS installed outside Vortex',
      message: 'Mismatched UE4SS version, some mods may not load. Turning on Autoinstall UE4SS in Game settings and managing UE4SS through Vortex is recommended.',
    });
  }
}

// Rename each of OUTSIDE_UE4SS_FILES in the game folder from suffix `from` to suffix `to` ('' or
// BACKUP_TAG), where the file exists and the new name is free.
// Files in `deployed` (lower-case paths in the game folder) are Vortex's and are left alone.
async function renameOutsideUe4ss(gamePath, from, to, deployed = new Set()) {
  for (const relative of OUTSIDE_UE4SS_FILES.filter((file) => !deployed.has(lower(file)))) {
    const file = path.join(gamePath, relative);
    if (await fileExists(file + from) && !await fileExists(file + to)) {
      await fs.renameAsync(file + from, file + to);
    }
  }
}

// Runs after each deploy.
// Vortex's UE4SS may be deployed over one installed some other way. Vortex keeps each file it replaces
// as .vortex_backup, and restores it when its UE4SS is disabled, removed or purged. The files it doesn't
// replace (OUTSIDE_UE4SS_FILES) would still load the old UE4SS, so:
// - while Vortex's UE4SS is deployed, set those files aside the same way (rename to .vortex_backup).
// - otherwise, put them back.
// This runs on every deploy, as a purge puts them back.
async function onDidDeploy(api, profileId, deployment) {
  const state = api.getState();
  const gamePath = selectors.discoveryByGame(state, GAME_ID)?.path;
  if (selectors.profileById(state, profileId)?.gameId !== GAME_ID || gamePath === undefined) {
    return;
  }
  // Each deployed file's path in the game folder (its mod type's folder, then its mod's subfolder, then
  // its path).
  const deployed = new Set(Object.entries(deployment || {}).flatMap(([typeId, files]) => {
    const folder = typeId === UE4SS_TYPE ? BINARIES : '';
    return (files || []).map((file) => lower(path.join(folder, file.target || '', file.relPath)));
  }));
  if (deployed.has(lower(UE4SS_DLL_PATHS[0]))) {
    try {
      await renameOutsideUe4ss(gamePath, '', BACKUP_TAG, deployed);
    } catch (error) {
      api.showErrorNotification('Couldn\'t set aside the old UE4SS', error, { allowReport: false });
    }
  } else {
    try {
      await renameOutsideUe4ss(gamePath, BACKUP_TAG, '', deployed);
    } catch (error) {
      log('warn', 'couldn\'t put back the UE4SS set aside', error.message);
    }
  }
}

// Ask whether Vortex may replace a UE4SS installed outside it:
// - Manage: replaces it with the pinned build.
// - Leave it: turns the setting off.
// - dismissed: asked again next time the game is managed.
async function askToManageUe4ss(api, dll) {
  const pinned = await isPinnedDll(dll);
  api.sendNotification({
    id: NOTIFICATION_MANAGE,
    type: pinned ? 'info' : 'warning',
    title: 'UE4SS installed outside Vortex',
    message: pinned
      ? 'Let Vortex manage it?'
      : 'Replace it with the version mods need?',
    actions: [
      {
        title: 'Manage',
        action: (dismiss) => {
          dismiss();
          api.store.dispatch(setAutoinstallUe4ss(true));
          // Returned for the tests (Vortex ignores the return value).
          return installPinnedUe4ss(api);
        },
      },
      {
        title: 'Leave it',
        action: (dismiss) => {
          dismiss();
          api.store.dispatch(setAutoinstallUe4ss(false));
          api.sendNotification({
            id: NOTIFICATION_LEFT_ALONE,
            type: 'info',
            message: 'Autoinstall UE4SS is off (Game settings > Mods).',
            displayMS: 10000,
          });
        },
      },
    ],
  });
}

// On setup (each time the game is managed). Does nothing if Vortex already has a UE4SS mod (a disabled
// one stays disabled). Otherwise:
// - setting on and chosen by the player: install the pinned build, replacing any installed outside
//   Vortex.
// - setting on by default only: install the pinned build, but ask first if one is installed outside
//   Vortex.
// - setting off: install nothing, and leave one installed outside Vortex alone (notifying the player).
async function ensureUe4ss(api, discovery) {
  const state = api.getState();
  if (ue4ssMods(state).length > 0) {
    return;
  }
  const dll = await gameFolderUe4ss(discovery.path);
  if (!autoinstallsUe4ss(state)) {
    if (dll === undefined) {
      log('info', 'UE4SS isn\'t installed, and Autoinstall UE4SS is off');
    } else {
      log('info', 'UE4SS is installed outside Vortex, and Autoinstall UE4SS is off: left alone', { dll });
      await notifyOutsideUe4ss(api, dll);
    }
    return;
  }
  if (dll === undefined) {
    await installPinnedUe4ss(api);
  } else if (choseAutoinstall(state)) {
    log('info', 'UE4SS is installed outside Vortex: replacing it with the pinned build', { dll });
    await installPinnedUe4ss(api);
  } else {
    log('info', 'UE4SS is installed outside Vortex: asking whether Vortex may manage it', { dll });
    await askToManageUe4ss(api, dll);
  }
}

// The player turning Autoinstall UE4SS on acts at once, as it would when the game is next managed (see
// `ensureUe4ss`), so no restart is needed. Turning it off leaves an installed UE4SS alone.
async function onAutoinstallChanged(api, previous, current) {
  if (current !== true || previous === true) {
    return;
  }
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  if (selectors.activeGameId(state) === GAME_ID && discovery?.path) {
    await ensureUe4ss(api, discovery);
  }
}

// Runs before mods are removed.
// A mod about to be replaced (a reinstall or an update) has its folder choice kept for the install
// that replaces it (see `REPLACED_CHOICES`).
// The player removing every UE4SS mod turns the setting off. Vortex's own removals (updates,
// replacements, unmanaging the game) don't.
// A UE4SS that Vortex's replaced comes back. Vortex restores its backups, and this puts back the files
// `onDidDeploy` set aside.
async function onWillRemoveMods(api, gameId, modIds, options) {
  if (gameId !== GAME_ID) {
    return;
  }
  const state = api.getState();
  if (options?.willBeReplaced === true) {
    for (const modId of modIds) {
      const choices = util.getSafe(state, ['persistent', 'mods', GAME_ID, modId, 'attributes', 'installerChoices'],
        undefined);
      if (choices?.type === FOLDER_CHOICE) {
        REPLACED_CHOICES.set(modId, choices);
      }
    }
    return;
  }
  if (![undefined, 'user_manual'].includes(options?.reason)) {
    return;
  }
  const mods = ue4ssMods(state);
  if (mods.length === 0 || !mods.every((mod) => modIds.includes(mod.id))) {
    return;
  }
  if (autoinstallsUe4ss(state)) {
    api.store.dispatch(setAutoinstallUe4ss(false));
  }
  const gamePath = selectors.discoveryByGame(state, GAME_ID)?.path;
  if (gamePath !== undefined) {
    try {
      await renameOutsideUe4ss(gamePath, BACKUP_TAG, '');
    } catch (error) {
      log('warn', 'couldn\'t put back the UE4SS set aside', error.message);
    }
  }
  api.sendNotification({
    id: NOTIFICATION_REMOVED,
    type: 'info',
    title: 'UE4SS removed',
    message: 'Autoinstall UE4SS is off (Game settings > Mods).',
    displayMS: 20000,
  });
}

// When another game is managed, dismiss the UE4SS notifications.
function onGameModeActivated(api) {
  if (selectors.activeGameId(api.getState()) !== GAME_ID) {
    for (const id of NOTIFICATIONS_ABOUT_UE4SS) {
      api.dismissNotification(id);
    }
  }
}

// UE4SS Checks

// A bulleted list for a check's More dialog, on its own lines. Vortex's dialogs show `[list]` without
// bullets or indents, so each item is written as an indented "- item" line instead.
function bulletList(items) {
  return items.map((item) => `[br][/br]  - ${item}`).join('') + '[br][/br]';
}

// The enabled mods that need UE4SS to load: those the installers marked (`NEEDS_UE4SS`), and of the
// rest (mods Vortex's own installers placed), those with files in ue4ss/Mods/ or
// Content/Paks/LogicMods/.
async function modsNeedingUe4ss(state) {
  const profileId = profileOf(state);
  const staging = selectors.installPathForGame(state, GAME_ID);
  const mods = Object.values(util.getSafe(state, ['persistent', 'mods', GAME_ID], {}));
  const needing = [];
  for (const mod of mods) {
    if (mod.state !== 'installed' || !isEnabled(state, profileId, mod.id)) {
      continue;
    }
    const needs = mod.attributes?.[NEEDS_UE4SS];
    if (needs === true) {
      needing.push(mod);
    } else if (needs === undefined && !mod.type) {
      const folder = path.join(staging, mod.installationPath);
      if (await fileExists(path.join(folder, UE4SS_MODS)) || await fileExists(path.join(folder, LOGIC_MODS))) {
        needing.push(mod);
      }
    }
  }
  return needing;
}

// Warns when mods need UE4SS and the game has none, or only a disabled one.
// Fix installs the pinned build, or enables the disabled one. Can't be hidden.
async function checkUe4ssNeeded(api) {
  const state = api.getState();
  if (selectors.activeGameId(state) !== GAME_ID) {
    return undefined;
  }
  const needing = await modsNeedingUe4ss(state);
  if (needing.length === 0) {
    return undefined;
  }
  const status = await ue4ssStatus(state);
  if (status.kind === 'enabled' || status.kind === 'outside') {
    return undefined;
  }
  const disabled = status.kind === 'disabled';
  const names = needing.map((mod) => nameWithVersion(mod)).sort((a, b) => a.localeCompare(b));
  const change = disabled ? `enable ${await ue4ssLabel(state, status.mod)}`
    : `install UE4SS ${PINNED_ATTRIBUTES.version}`;
  return {
    severity: 'warning',
    allowSuppress: false,
    description: {
      short: disabled ? 'Some mods need UE4SS, which is disabled' : 'Some mods need UE4SS',
      long: `Mods which require UE4SS:${bulletList(names)}[br][/br]Click Fix to:${bulletList([change])}`,
      localize: false,
    },
    automaticFix: () => (disabled ? switchTo(api, status.mod.id) : installPinnedUe4ss(api)),
  };
}

// A UE4SS mod's version, as UE4SS names its builds (3.0.1-1181-g83330635), from its version, its
// archive's name or its name. Undefined if none of them has one.
function ue4ssVersion(mod) {
  const attributes = mod.attributes || {};
  for (const text of [attributes.version, attributes.fileName, attributes.logicalFileName, attributes.name,
    mod.id]) {
    const found = String(text ?? '').match(/\d+\.\d+\.\d+-\d+-g[0-9a-f]+/i);
    if (found !== null) {
      return found[0];
    }
  }
  return undefined;
}

// A UE4SS build as numbers to compare, from a version such as 3.0.1-1181-g83330635 or 3.0.1-1181:
// the release, then the count of commits since it, which only goes up. Undefined if it isn't one.
function ue4ssBuild(version) {
  const found = String(version ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)-(\d+)(-g[0-9a-f]+)?$/i);
  return found === null ? undefined : found.slice(1, 5).map(Number);
}

// Below zero if build `a` is older than build `b`, zero if the same, above zero if newer.
function compareBuilds(a, b) {
  const difference = a.findIndex((number, index) => number !== b[index]);
  return difference === -1 ? 0 : a[difference] - b[difference];
}

// A UE4SS mod's build: the pinned one if its UE4SS.dll is the pinned build's, else from its names (see
// `ue4ssVersion`). Undefined if neither tells.
async function ue4ssModBuild(state, mod) {
  if (await isPinnedBuild(state, mod) === true) {
    return { version: PINNED_ATTRIBUTES.version, build: ue4ssBuild(PINNED_ATTRIBUTES.version) };
  }
  const version = ue4ssVersion(mod);
  return version === undefined ? undefined : { version, build: ue4ssBuild(version) };
}

// A UE4SS mod as its warnings name it: "UE4SS" and its build, if that can be told, else its name and
// version as the mods list has them.
async function ue4ssLabel(state, mod) {
  const found = await ue4ssModBuild(state, mod);
  return found === undefined ? nameWithVersion(mod) : `UE4SS ${found.version}`;
}

// The oldest UE4SS build the enabled mods can run on: the pinned build, or newer if an enabled mod's
// manifest.json says so (`ue4ss_version`, the build a C++ mod was built against). UE4SS's C++
// interface is stable from 1181, so a newer build than a mod needs is fine. With the mods asking for
// that build, if any did.
function ue4ssNeeded(state) {
  const profileId = profileOf(state);
  let needed = { version: PINNED_ATTRIBUTES.version, build: ue4ssBuild(PINNED_ATTRIBUTES.version), mods: [] };
  for (const mod of Object.values(util.getSafe(state, ['persistent', 'mods', GAME_ID], {}))) {
    const version = mod.attributes?.[METADATA]?.ue4ss;
    const build = ue4ssBuild(version);
    if (mod.state !== 'installed' || !isEnabled(state, profileId, mod.id) || build === undefined) {
      continue;
    }
    const difference = compareBuilds(build, needed.build);
    if (difference > 0) {
      needed = { version: version.replace(/^v/i, ''), build, mods: [mod] };
    } else if (difference === 0) {
      needed.mods.push(mod);
    }
  }
  return needed;
}

// Warns when the enabled UE4SS is older than the mods need (see `ue4ssNeeded`), or its build can't be
// told and it isn't the pinned build. A newer build is fine.
// Fix enables a UE4SS in Vortex that is new enough (the pinned build first), else installs the pinned
// build if that is new enough. The other stays installed, disabled. Can be hidden for good.
async function checkUe4ssBuild(api) {
  const state = api.getState();
  if (selectors.activeGameId(state) !== GAME_ID) {
    return undefined;
  }
  const status = await ue4ssStatus(state);
  if (status.kind !== 'enabled' || await isPinnedBuild(state, status.mod) === undefined) {
    return undefined;
  }
  const needed = ue4ssNeeded(state);
  const enabled = await ue4ssModBuild(state, status.mod);
  if (enabled !== undefined && compareBuilds(enabled.build, needed.build) >= 0) {
    return undefined;
  }
  // a UE4SS in Vortex new enough, the pinned build first, else the newest
  const candidates = [];
  for (const mod of ue4ssMods(state).filter((candidate) => candidate.id !== status.mod.id)) {
    const found = await ue4ssModBuild(state, mod);
    if (found !== undefined && compareBuilds(found.build, needed.build) >= 0) {
      candidates.push({ mod, ...found });
    }
  }
  const pinnedBuild = ue4ssBuild(PINNED_ATTRIBUTES.version);
  candidates.sort((a, b) => (compareBuilds(a.build, pinnedBuild) === 0 ? -1
    : compareBuilds(b.build, pinnedBuild) === 0 ? 1 : compareBuilds(b.build, a.build)));
  const pinnedWillDo = compareBuilds(pinnedBuild, needed.build) >= 0;
  const installed = enabled === undefined ? `"${util.renderModName(status.mod)}"` : `UE4SS ${enabled.version}`;
  let long = `Mods require UE4SS ${needed.version} or newer but ${installed} is installed.[br][/br][br][/br]`;
  if (needed.mods.length > 0) {
    const names = needed.mods.map((mod) => nameWithVersion(mod)).sort((a, b) => a.localeCompare(b));
    long += `Mods which require UE4SS ${needed.version}:${bulletList(names)}[br][/br]`;
  }
  // Fix leaves the enabled one installed, disabled
  const disable = `disable ${enabled === undefined ? nameWithVersion(status.mod) : `UE4SS ${enabled.version}`}`;
  let automaticFix;
  if (candidates.length > 0) {
    long += `Click Fix to:${bulletList([`enable UE4SS ${candidates[0].version}`, disable])}`;
    automaticFix = () => switchTo(api, candidates[0].mod.id);
  } else if (pinnedWillDo) {
    long += `Click Fix to:${bulletList([`install UE4SS ${PINNED_ATTRIBUTES.version}`, disable])}`;
    automaticFix = () => installPinnedUe4ss(api);
  } else {
    long += `Install UE4SS ${needed.version} or newer.`;
  }
  return {
    severity: 'warning',
    description: { short: 'UE4SS isn\'t the version mods need', long, localize: false },
    ...(automaticFix === undefined ? {} : { automaticFix }),
  };
}

// Mod Requirements

// Whether version `have` is at least version `want`, comparing dotted numbers (1.10.0 is newer than 1.9.0).
// Returns true if either isn't dotted numbers, as the two can't be compared.
function versionAtLeast(have, want) {
  const numbers = (version) => String(version).split('.').map(Number);
  const [haveNumbers, wantNumbers] = [numbers(have), numbers(want)];
  if ([...haveNumbers, ...wantNumbers].some(Number.isNaN)) {
    return true;
  }
  for (let i = 0; i < Math.max(haveNumbers.length, wantNumbers.length); i += 1) {
    const difference = (haveNumbers[i] ?? 0) - (wantNumbers[i] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

// Warns when enabled mods require mods (from their manifest.json, see `readMetadata`) which aren't
// installed, are disabled, or are older than the version required. Mods are matched by their
// manifest.json's name, never by the name the mods list shows, so renaming a mod changes nothing, and
// this works the same for mods from Nexus Mods and from files. Can be hidden for good.
// Fix enables required mods that are installed but disabled, disabling an older copy enabled instead
// (see `requirementsFix`). It can't install a missing one, as Vortex can't download a mod by its
// manifest.json's name.
// Vortex's own "requires" rules aren't used. Vortex tries to install a required mod as soon as the mod
// requiring it is enabled, and disables any rule it can't fulfil, which is every rule without a Nexus
// Mods download behind it.
function checkRequirements(api) {
  const state = api.getState();
  if (selectors.activeGameId(state) !== GAME_ID) {
    return Promise.resolve(undefined);
  }
  const profileId = profileOf(state);
  const mods = Object.values(util.getSafe(state, ['persistent', 'mods', GAME_ID], {}))
    .filter((mod) => mod.state === 'installed');
  const copies = copiesByName(mods);
  const enabledIds = new Set(mods.filter((mod) => isEnabled(state, profileId, mod.id)).map((mod) => mod.id));
  // Each enabled mod that is missing requirements, with the requirements it is missing.
  const problems = [];
  for (const mod of mods.filter((candidate) => enabledIds.has(candidate.id))) {
    const missing = [];
    for (const requirement of mod.attributes?.[METADATA]?.requirements || []) {
      const found = copies.get(lower(requirement.name)) || [];
      const newEnough = (copy) => versionAtLeast(copy.attributes[METADATA].version, requirement.version);
      const required = requirement.name.replace(/_/g, ' ');
      if (found.some((copy) => enabledIds.has(copy.id) && newEnough(copy))) {
        continue;
      }
      if (found.length === 0) {
        missing.push(required);
      } else if (!found.some((copy) => enabledIds.has(copy.id)) && found.some(newEnough)) {
        missing.push(`${required} (disabled)`);
      } else {
        missing.push(`${required} ${requirement.version} or newer`);
      }
    }
    if (missing.length > 0) {
      problems.push({ name: nameWithVersion(mod), missing: missing.sort((a, b) => a.localeCompare(b)) });
    }
  }
  if (problems.length === 0) {
    return Promise.resolve(undefined);
  }
  problems.sort((a, b) => a.name.localeCompare(b.name));
  // A blank line between mods.
  let long = problems.map(({ name, missing }) => `${name} missing dependencies:${bulletList(missing)}`)
    .join('[br][/br]');
  const fix = requirementsFix(mods, copies, enabledIds);
  if (fix.enable.length > 0) {
    long += `[br][/br]${fixInWords(fix)}`;
  }
  return Promise.resolve({
    severity: 'warning',
    description: { short: 'Some mods are missing requirements', long, localize: false },
    ...(fix.enable.length > 0 ? { automaticFix: () => applyFix(api, profileId, fix) } : {}),
  });
}

// The installed mods with a manifest.json name, by that name in lower case, newest version first.
function copiesByName(mods) {
  const copies = new Map();
  for (const mod of mods.filter((candidate) => candidate.attributes?.[METADATA]?.name !== undefined)) {
    const name = lower(mod.attributes[METADATA].name);
    copies.set(name, [...(copies.get(name) || []), mod]);
  }
  const version = (mod) => mod.attributes[METADATA].version;
  const newer = (a, b) => (versionAtLeast(version(b), version(a)) ? 0 : -1);
  for (const found of copies.values()) {
    found.sort((a, b) => newer(a, b) || -newer(b, a));
  }
  return copies;
}

// The mods to enable and disable so that the enabled mods have what they require. For each requirement
// with no copy enabled that is new enough, the newest disabled copy new enough is enabled, then what
// that requires, and so on. Other copies of it (with the same manifest.json name) are disabled, as two
// would conflict. The newest copy is at least as new as those, so nothing that needed them goes without.
function requirementsFix(mods, copies, enabledIds) {
  const enabled = new Set(enabledIds);
  const queue = mods.filter((mod) => enabledIds.has(mod.id));
  while (queue.length > 0) {
    const mod = queue.shift();
    for (const requirement of mod.attributes?.[METADATA]?.requirements || []) {
      const found = copies.get(lower(requirement.name)) || [];
      const newEnough = (copy) => versionAtLeast(copy.attributes[METADATA].version, requirement.version);
      if (found.some((copy) => enabled.has(copy.id) && newEnough(copy))) {
        continue;
      }
      const copy = found.find(newEnough);
      if (copy !== undefined) {
        for (const other of found) {
          enabled.delete(other.id);
        }
        enabled.add(copy.id);
        queue.push(copy);
      }
    }
  }
  return {
    enable: mods.filter((mod) => enabled.has(mod.id) && !enabledIds.has(mod.id)),
    disable: mods.filter((mod) => enabledIds.has(mod.id) && !enabled.has(mod.id)),
  };
}

// Disable, then enable, as a Fix does (Vortex then deploys, if set to).
async function applyFix(api, profileId, fix) {
  if (fix.disable.length > 0) {
    await actions.setModsEnabled(api, profileId, fix.disable.map((mod) => mod.id), false);
  }
  if (fix.enable.length > 0) {
    await actions.setModsEnabled(api, profileId, fix.enable.map((mod) => mod.id), true);
  }
}

// What a requirements Fix does, for its More dialog: a list, one change a line, enables first.
function fixInWords(fix) {
  const names = (list) => list.map(nameWithVersion).sort((a, b) => a.localeCompare(b));
  const changes = [...names(fix.enable).map((name) => `enable ${name}`),
    ...names(fix.disable).map((name) => `disable ${name}`)];
  return `Click Fix to:${bulletList(changes)}`;
}

// A mod's name as the mods list shows it, with its version, so that two copies of a mod can be told
// apart: the mods list's version, else its manifest.json's. The version is left off if there is none,
// or the name has it already.
function nameWithVersion(mod) {
  const name = util.renderModName(mod);
  const version = mod.attributes?.version || mod.attributes?.[METADATA]?.version;
  return typeof version === 'string' && version !== '' && !name.includes(version) ? `${name} ${version}` : name;
}

// Mods List Attributes

// Fill in the attributes the mods list shows:
// - mods from a site Vortex knows (Nexus Mods) keep that site's data.
// - other mods get their name, version and description from their manifest.json (nothing from the
//   archive's name), a source (their website, else "Other", which Vortex warns about), and the category
//   "Miscellaneous" once Vortex has the game's categories.
// Just installed (`justInstalled`), the manifest replaces what Vortex made up. Later, only empty
// attributes are filled.
// A name the player gave is never replaced. `NAME` records the name the extension gave, which an
// attribute extractor carries over reinstalls and updates, so the two can be told apart.
function fillAttributes(api, modIds, justInstalled = false) {
  const state = api.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const categories = util.getSafe(state, ['persistent', 'categories', GAME_ID], {});
  const category = Object.keys(categories).find((id) => categories[id]?.name === CATEGORY);
  const updates = [];
  for (const modId of modIds) {
    const mod = mods[modId];
    if (mod?.state !== 'installed') {
      continue;
    }
    const attributes = mod.attributes || {};
    const metadata = attributes[METADATA] || {};
    // A mod whose source is "unknown" isn't from a site (see `UNKNOWN_SOURCE`).
    const unknownSource = [UNKNOWN_SOURCE, undefined].includes(attributes.source);
    const fromSite = !unknownSource && !['unsupported', 'website'].includes(attributes.source);
    const namedByPlayer = !['', undefined].includes(attributes.customFileName)
      && attributes.customFileName !== attributes[NAME];
    const fromArchive = fromSite ? {} : {
      ...(namedByPlayer ? {} : { customFileName: metadata.title, [NAME]: metadata.title }),
      version: metadata.version,
      description: metadata.description,
      shortDescription: metadata.description,
    };
    const filled = {
      ...fromArchive,
      category: category === undefined ? undefined : parseInt(category, 10),
    };
    if (unknownSource) {
      Object.assign(filled, metadata.url !== undefined
        ? { source: 'website', url: metadata.url } : { source: 'unsupported' });
    }
    const changes = Object.fromEntries([
      ...Object.entries(filled).filter(([key, value]) => value !== undefined
        && (attributes[key] === undefined || attributes[key] === ''
          || (key === 'source' && attributes[key] === UNKNOWN_SOURCE))),
      ...Object.entries(justInstalled ? fromArchive : {}).filter(([key, value]) =>
        value !== undefined && attributes[key] !== value),
    ]);
    if (Object.keys(changes).length > 0) {
      log('debug', 'filling in a mod\'s attributes', { modId, changes });
      updates.push(actions.setModAttributes(GAME_ID, modId, changes));
    }
  }
  if (updates.length > 0) {
    util.batchDispatch(api.store, updates);
  }
}

// The ids of every mod for the game.
const allMods = (api) => Object.keys(util.getSafe(api.getState(), ['persistent', 'mods', GAME_ID], {}));

// Runs after a mod is installed. Fills in its attributes, and tells the player if a bundled UE4SS was
// left out. Only this mod's attributes are filled, others fill in as they finish, after Nexus Mods'
// attributes, which Vortex adds only where empty.
function onDidInstallMod(api, gameId, modId) {
  if (gameId !== GAME_ID) {
    return;
  }
  fillAttributes(api, [modId], true);
  const mod = util.getSafe(api.getState(), ['persistent', 'mods', GAME_ID, modId], undefined);
  if (mod?.attributes?.[BUNDLED_UE4SS] === true) {
    api.sendNotification({
      id: `alchemyfactory-bundled-ue4ss-${modId}`,
      type: 'info',
      message: `Left out the UE4SS files bundled with ${util.renderModName(mod)}`,
      displayMS: 10000,
    });
  }
}

// The Game

// The game's version, the Steam build id (`buildid` in the app manifest), which changes each update.
// The executables only carry the engine's version. Throws without a manifest, and Vortex then falls back
// to the executable's version.
async function gameVersion(gamePath) {
  const manifest = path.join(gamePath, '..', '..', `appmanifest_${STEAM_APP_ID}.acf`);
  const build = /"buildid"\s+"(\d+)"/i.exec(await fs.readFileAsync(manifest, 'utf8'))?.[1];
  if (build === undefined) {
    throw new Error(`${manifest} has no buildid`);
  }
  return build;
}

// The extension's entry point.
function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: 'Alchemy Factory',
    mergeMods: true,
    // Deploys remove the empty folders Vortex made (otherwise only purges do).
    requiresCleanup: true,
    queryArgs: { steam: [{ id: STEAM_APP_ID, prefer: 0 }] },
    queryModPath: () => '.',
    logo: 'gameart.jpg',
    executable: () => EXECUTABLE,
    requiredFiles: [EXECUTABLE, SHIPPING_EXECUTABLE],
    // Launch through Steam when the game was found there (steam -applaunch), so Steam tracks playtime
    // and achievements. Vortex needs the app id in addInfo, otherwise it looks the game up by its
    // folder and fails.
    requiresLauncher: (gamePath, store) =>
      Promise.resolve(store === 'steam'
        ? { launcher: 'steam', addInfo: { appId: STEAM_APP_ID, parameters: [] } }
        : undefined),
    getGameVersion: (gamePath) => gameVersion(gamePath),
    setup: (discovery) => setup(context.api, discovery),
    // Symlinked .utoc/.ucas files crash UE5 at startup (Nexus Mods reproduced it), so hardlinks only.
    compatible: { symlinks: false },
    details: {
      // Every UE4SS mod has an enabled.txt, so a mod and its patch would always conflict.
      ignoreConflicts: [path.join('**', 'enabled.txt')],
    },
  });

  context.registerReducer(SETTINGS, settingsReducer);
  context.registerSettings('Mods', SettingsPage, undefined,
    () => selectors.activeGameId(context.api.getState()) === GAME_ID, 51);

  // Installers, in priority order. UE4SS first, so its archive is never taken for a mod, then the game
  // folder's layout, UE4SS mods, containers, and last what isn't a mod, before Vortex's fallback
  // installer (1000).
  const options = (choices, unattended, destinationPath) =>
    ({ api: context.api, choices: choices ?? replacedChoices(destinationPath), unattended });
  context.registerInstaller('alchemyfactory-ue4ss', 10, testUe4ss,
    (files, destinationPath, gameId, progress, choices, unattended) =>
      installUe4ss(files, destinationPath, options(choices, unattended, destinationPath)));
  context.registerInstaller('alchemyfactory-game-layout', 15, testGameLayout, installGameLayout);
  context.registerInstaller('alchemyfactory-ue4ss-mod', 20, testUe4ssMod,
    (files, destinationPath, gameId, progress, choices, unattended) =>
      installUe4ssMod(files, destinationPath, options(choices, unattended, destinationPath)));
  context.registerInstaller('alchemyfactory-containers', 25, testContainers,
    (files, destinationPath, gameId, progress, choices, unattended) =>
      installContainers(files, destinationPath, options(choices, unattended, destinationPath)));
  context.registerInstaller('alchemyfactory-unplaceable', 50, testUnplaceable, installUnplaceable);

  // UE4SS's mod type (see Mod Types). Only its installer gives it, so its test claims nothing.
  context.registerModType(UE4SS_TYPE, 25, (gameId) => gameId === GAME_ID,
    () => {
      const gamePath = selectors.discoveryByGame(context.api.getState(), GAME_ID)?.path;
      return gamePath === undefined ? undefined : path.join(gamePath, BINARIES);
    },
    () => Promise.resolve(false), { name: 'UE4SS' });

  // Carry the name the extension gave (`NAME`) over reinstalls and updates, as Vortex does the
  // player's, so `fillAttributes` can tell them apart.
  context.registerAttributeExtractor(100, (input) =>
    Promise.resolve({ [NAME]: input?.previous?.[NAME] }));
  context.registerAttributeExtractor(20, pinnedDownloadAttributes);

  for (const event of CHECK_EVENTS) {
    context.registerTest(CHECK_UE4SS_NEEDED, event, () => checkUe4ssNeeded(context.api));
    context.registerTest(CHECK_UE4SS_BUILD, event, () => checkUe4ssBuild(context.api));
    context.registerTest(CHECK_REQUIREMENTS, event, () => checkRequirements(context.api));
  }

  const active = () => selectors.activeGameId(context.api.getState()) === GAME_ID;
  // Pinned to the mods toolbar by default (Vortex 2.9 puts the rest behind "..."). The player may unpin
  // it.
  context.registerAction('mod-icons', 300, 'download', { pinned: true }, 'Install UE4SS', () => {
    installUe4ssAction(context.api)
      .catch((error) => log('warn', 'Install UE4SS failed', error.message));
  }, active);
  context.registerAction('mod-icons', 300, 'open-ext', {}, 'Open UE4SS Mods Folder', () => {
    const discovery = selectors.discoveryByGame(context.api.getState(), GAME_ID);
    util.opn(path.join(discovery.path, UE4SS_MODS)).catch(() => null);
  }, active);

  context.once(() => {
    context.api.events.on('did-install-mod', (gameId, archiveId, modId) =>
      onDidInstallMod(context.api, gameId, modId));
    // The categories arrive from Nexus Mods after the game is first managed.
    context.api.onStateChange(['persistent', 'categories', GAME_ID],
      () => fillAttributes(context.api, allMods(context.api)));
    context.api.onAsync('will-remove-mods', (gameId, modIds, removeOptions) =>
      onWillRemoveMods(context.api, gameId, modIds, removeOptions));
    context.api.onAsync('did-deploy', (profileId, deployment) =>
      onDidDeploy(context.api, profileId, deployment));
    context.api.events.on('gamemode-activated', () => onGameModeActivated(context.api));
    context.api.onStateChange([...SETTINGS, 'autoinstallUe4ss'], (previous, current) => {
      onAutoinstallChanged(context.api, previous, current)
        .catch((error) => log('warn', 'setting up UE4SS failed', error.message));
    });
  });

  return true;
}

// Runs on setup, each time the game is managed.
async function setup(api, discovery) {
  if (!discovery?.path) {
    return;
  }
  try {
    // Not ue4ss/Mods. UE4SS's install makes that, and on its own it would look like UE4SS is installed.
    await fs.ensureDirWritableAsync(path.join(discovery.path, MODS_PAKS));
    fillAttributes(api, allMods(api));
    // Not awaited. Vortex only finishes activating the game once setup returns, and the install may
    // wait on a download (`installPinned` reports failures).
    ensureUe4ss(api, discovery)
      .catch((error) => log('warn', 'setting up UE4SS failed', error.message));
  } catch (error) {
    log('warn', 'setting up Alchemy Factory failed', error.message);
  }
}

module.exports = {
  default: main,
  // For the tests.
  installers: {
    testUe4ss, installUe4ss, testGameLayout, installGameLayout, testUe4ssMod, installUe4ssMod,
    testContainers, installContainers, testUnplaceable, installUnplaceable,
  },
  UE4SS,
  downloadUe4ss,
  fillAttributes,
  readMetadata,
  notifyOutsideUe4ss,
  ensureUe4ss,
  onAutoinstallChanged,
  importDownload,
  installPinnedUe4ss,
  installUe4ssAction,
  onWillRemoveMods,
  replacedChoices,
  onDidDeploy,
  pinnedDownloadAttributes,
  checkUe4ssNeeded,
  checkUe4ssBuild,
  checkRequirements,
  gameVersion,
  onDidInstallMod,
  onGameModeActivated,
  settingsReducer,
  setAutoinstallUe4ss,
};
