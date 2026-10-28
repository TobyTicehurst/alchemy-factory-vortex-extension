// The installers with archives' file lists as Vortex gives them (relative paths, the system's
// separator, folders ending in one); the rest against a stand-in Vortex. Run with `node --test`.

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');
const test = require('node:test');

// Files as Vortex's fs reads them, by path (a folder exists if a file is in it): archives'
// contents, staged mods, the game folder. Each has a write time; reads are counted.
const disk = new Map();
const times = new Map();
let clock = 0;
const reads = [];
const diskKey = (file) => path.normalize(file).toLowerCase();
const write = (file, content) => {
  disk.set(diskKey(file), content);
  times.set(diskKey(file), clock += 1);
};
const onDisk = (files = {}) => {
  disk.clear();
  for (const [file, content] of Object.entries(files)) {
    write(file, content);
  }
};
const missing = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });

class UserCanceled extends Error {}
class ProcessCanceled extends Error {}
class SetupError extends Error {}

// the parts of vortex-api and redux-act the extension uses
const vortexApi = {
  actions: {
    setModAttributes: (gameId, modId, attributes) => ({ type: 'setModAttributes', modId, attributes }),
    setModsEnabled: async (api, profileId, modIds, enabled) => {
      api.enabled.push({ modIds, enabled });
    },
  },
  fs: {
    readFileAsync: async (file) => {
      const content = disk.get(diskKey(file));
      if (content === undefined) {
        throw missing(file);
      }
      reads.push(diskKey(file));
      return content;
    },
    statAsync: async (file) => {
      const content = disk.get(diskKey(file));
      if (content !== undefined) {
        return { size: content.length, mtimeMs: times.get(diskKey(file)) };
      }
      const folder = diskKey(file) + path.sep;
      if (![...disk.keys()].some((other) => other.startsWith(folder))) {
        throw missing(file);
      }
      return {};
    },
    renameAsync: async (from, to) => {
      const content = disk.get(diskKey(from));
      if (content === undefined) {
        throw missing(from);
      }
      disk.delete(diskKey(from));
      write(to, content);
    },
    removeAsync: async (file) => {
      disk.delete(diskKey(file));
    },
    ensureDirWritableAsync: async () => {},
    writeFileAsync: async () => {},
  },
  log: () => {},
  selectors: {
    activeGameId: (state) => state.activeGameId,
    lastActiveProfileForGame: () => 'profile',
    profileById: (state, profileId) => state.persistent.profiles[profileId],
    discoveryByGame: (state) => state.discovery,
    installPathForGame: () => 'C:\\staging',
  },
  util: {
    getSafe: (state, keys, fallback) =>
      keys.reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), state)
        ?? fallback,
    batchDispatch: (store, actions) => actions.forEach((action) => store.dispatch(action)),
    toPromise: (func) => new Promise((resolve, reject) =>
      func((error, result) => (error ? reject(error) : resolve(result)))),
    renderModName: (mod) => mod.attributes?.customFileName ?? mod.id,
    getVortexPath: () => 'C:\\temp',
    UserCanceled,
    ProcessCanceled,
    SetupError,
  },
};
const reduxAct = {
  createAction: (type, payload = (value) => value) => {
    const creator = (...args) => ({ type, payload: payload(...args) });
    creator.toString = () => type;
    return creator;
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vortex-api') {
    return vortexApi;
  }
  if (request === 'redux-act') {
    return reduxAct;
  }
  return load.call(this, request, ...rest);
};
const extension = require('./index.js');
const {
  testUe4ss, installUe4ss, testGameLayout, installGameLayout, testUe4ssMod, installUe4ssMod,
  testContainers, installContainers, testUnplaceable, installUnplaceable,
} = extension.installers;

// the pinned build's UE4SS.dll, as these tests have it
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// Whether some text is shown to the player. Tests never check the exact wording, so it can change freely.
const shown = (text) => typeof text === 'string' && text.trim() !== '';
// what a check's Fix changes, from its More text's list, one change a line
const fixList = (long) => (long.split('Click Fix to:')[1] ?? '').split('[br][/br]')
  .map((line) => line.replace(/\s/g, ' ').trim()).filter((line) => line !== '');
extension.UE4SS.dllSha256 = sha256('the pinned build');

// archive paths, written with /, given with the system's separator
const archive = (...files) => files.map((file) => file.split('/').join(path.sep));
const win64 = (...parts) => path.join('AlchemyFactory', 'Binaries', 'Win64', ...parts);
const paks = (...parts) => path.join('AlchemyFactory', 'Content', 'Paks', ...parts);
// by mod type: the folder it deploys into (the default type's is the game folder)
const UE4SS_TYPE = 'alchemyfactory-ue4ss';
const typeFolders = { [UE4SS_TYPE]: win64(), '': '' };
const modTypeOf = (result) => result.instructions
  .find((instruction) => instruction.type === 'setmodtype')?.value ?? '';
// where a file lands in the game folder: its type's folder, then its destination
const inGame = (result, destination) => path.join(typeFolders[modTypeOf(result)], destination);
const copies = (result) => Object.fromEntries(result.instructions
  .filter((instruction) => instruction.type === 'copy')
  .map((instruction) => [instruction.source.split(path.sep).join('/'), inGame(result, instruction.destination)]));
const generated = (result) => result.instructions
  .filter((instruction) => instruction.type === 'generatefile')
  .map((instruction) => inGame(result, instruction.destination));
const choiceOf = (result) => result.instructions
  .find((instruction) => instruction.key === 'installerChoices')?.value;

// Vortex's state with these mods in the profile, those in `enabled` enabled
function stateWith({
  mods = {}, enabled = [], downloads = {}, settings, active = 'alchemyfactory', gamePath = 'C:\\game',
} = {}) {
  return {
    activeGameId: active,
    discovery: { path: gamePath },
    settings: settings === undefined ? {} : { alchemyFactory: settings },
    persistent: {
      mods: { alchemyfactory: mods },
      profiles: {
        profile: {
          gameId: 'alchemyfactory',
          modState: Object.fromEntries(enabled.map((id) => [id, { enabled: true }])),
        },
        other: { gameId: 'palworld', modState: {} },
      },
      downloads: { files: downloads },
      categories: {},
    },
  };
}

// the API given to the extension, recording what it asks
function fakeApi(state, { onEmit, dialog } = {}) {
  const api = {
    state,
    dispatched: [],
    notifications: [],
    dismissed: [],
    errors: [],
    enabled: [],
    emitted: [],
    dialogs: [],
    getState: () => api.state,
    store: { dispatch: (action) => api.dispatched.push(action) },
    sendNotification: (notification) => api.notifications.push(notification),
    dismissNotification: (id) => api.dismissed.push(id),
    showErrorNotification: (message, error) => api.errors.push({ message, error }),
    events: {
      emit: (event, ...args) => {
        api.emitted.push(event);
        onEmit?.(event, ...args);
      },
    },
    showDialog: async (type, title, content, actions) => {
      api.dialogs.push(content);
      if (dialog === undefined) {
        throw new Error('no dialog expected');
      }
      return dialog(content, actions);
    },
  };
  return api;
}

// mods: UE4SS (staged with this UE4SS.dll), and of the default type: a UE4SS mod, a Paks mod and a
// Blueprint mod, which the installers marked (`alchemyFactoryNeedsUe4ss`), and two Vortex's own
// installers placed, unmarked: one with a UE4SS mod in it (the vault) and one without
const installed = (id, type, attributes = {}) =>
  ({ id, state: 'installed', type, installationPath: id, attributes });
const ue4ssMod = (id = 'UE4SS') => installed(id, UE4SS_TYPE);
const stagedUe4ss = (id, build) => ({ [`C:\\staging\\${id}\\ue4ss\\UE4SS.dll`]: build });
const luaMod = installed('FrameRate', '', { alchemyFactoryNeedsUe4ss: true });
const pakMod = installed('FastBelts', '', { alchemyFactoryNeedsUe4ss: false });
const logicMod = installed('Logic', '', { alchemyFactoryNeedsUe4ss: true });
const vaultMod = installed('Vault', '');
const moviesMod = installed('Movies', '');
const stagedMods = {
  [`C:\\staging\\Vault\\${win64('ue4ss', 'Mods', 'Vault', 'Scripts', 'main.lua')}`]: '',
  [`C:\\staging\\Vault\\${paks('~mods', 'Vault_P.pak')}`]: '',
  [`C:\\staging\\Movies\\${path.join('AlchemyFactory', 'Content', 'Movies', 'Intro.bk2')}`]: '',
};
// the pinned build's download
const pinnedDownload = {
  pinned: { localPath: extension.UE4SS.zip, state: 'finished', game: ['alchemyfactory'] },
};
// Vortex installing a download: answers with the mod id, a moment later
const installsAs = (modId) => (event, downloadId, allow, callback) => {
  if (event === 'start-install-download') {
    setTimeout(() => callback(null, modId), 5);
  }
};

// the pinned UE4SS release's zip
const ue4ssZip = archive('ue4ss/', 'dwmapi.dll', 'ue4ss/Mods/', 'ue4ss/LICENSE',
  'ue4ss/UE4SS-settings.ini', 'ue4ss/UE4SS.dll', 'ue4ss/Mods/BPModLoaderMod/Scripts/main.lua',
  'ue4ss/Mods/shared/UEHelpers/UEHelpers.lua', 'ue4ss/Mods/mods.txt', 'ue4ss/Mods/mods.json',
  'ue4ss/UE4SS_SDK_Backends/UE4SS.json');

// the game folder's layout, with a Thunderstore manifest, icon and README beside
const gameLayoutZip = archive('manifest.json', 'icon.png', 'README.md',
  'AlchemyFactory/Content/Paks/~mods/MyMod_P.pak',
  'AlchemyFactory/Content/Paks/~mods/MyMod_P.utoc',
  'AlchemyFactory/Content/Paks/~mods/MyMod_P.ucas',
  'AlchemyFactory/Binaries/Win64/ue4ss/Mods/MyMod/Scripts/main.lua',
  'AlchemyFactory/Binaries/Win64/ue4ss/Mods/MyMod/enabled.txt');

// versions in folders, as one zip of Max Yield's X2 and X5
const variantsZip = archive('MaxYield/X2/MaxYield_P.pak', 'MaxYield/X2/MaxYield_P.utoc',
  'MaxYield/X2/MaxYield_P.ucas', 'MaxYield/X5/MaxYield_P.pak', 'MaxYield/X5/MaxYield_P.utoc',
  'MaxYield/X5/MaxYield_P.ucas', 'MaxYield/readme.txt');

// main, recording what it registers
function registered() {
  const found = {
    games: [], installers: [], tests: [], reducers: [], extractors: [], settings: [], modTypes: [],
    actions: [],
  };
  extension.default({
    api: { getState: () => stateWith() },
    registerGame: (game) => found.games.push(game),
    registerModType: (id, priority, isSupported, getPath, test, options) =>
      found.modTypes.push({ id, isSupported, getPath, test, options }),
    registerInstaller: (id, priority) => found.installers.push([priority, id]),
    registerAction: (group, position, icon, options, title) =>
      found.actions.push({ group, icon, options, title }),
    registerReducer: (statePath, reducer) => found.reducers.push([statePath, reducer]),
    registerSettings: (title) => found.settings.push(title),
    registerAttributeExtractor: (priority, extractor) => found.extractors.push(extractor),
    registerTest: (id, event) => found.tests.push(`${id} ${event}`),
    once: () => {},
  });
  return found;
}

test('the installers come in order: UE4SS, game layout, UE4SS mods, containers, then what isn\'t '
  + 'a mod', () => {
  assert.deepStrictEqual(registered().installers.sort((a, b) => a[0] - b[0]).map(([, id]) => id), [
    'alchemyfactory-ue4ss', 'alchemyfactory-game-layout', 'alchemyfactory-ue4ss-mod',
    'alchemyfactory-containers', 'alchemyfactory-unplaceable',
  ]);
});

test('the game: never symlinks, the folders deploys empty removed, enabled.txt never conflicts, its '
  + 'version from Steam, launched through Steam when found there', async () => {
  const [game] = registered().games;
  assert.deepStrictEqual(game.compatible, { symlinks: false });
  assert.deepStrictEqual(await game.requiresLauncher('C:\\game', 'steam'),
    { launcher: 'steam', addInfo: { appId: '3669570', parameters: [] } });
  assert.strictEqual(await game.requiresLauncher('C:\\game', undefined), undefined);
  assert.strictEqual(game.requiresCleanup, true);
  // Vortex sets SteamAPPId and steamAppId from queryArgs
  assert.strictEqual(game.environment, undefined);
  assert.deepStrictEqual(game.details, { ignoreConflicts: [path.join('**', 'enabled.txt')] });
  assert.strictEqual(typeof game.getGameVersion, 'function');
});

test('the checks run as the game is managed, and as mods are installed or enabled', () => {
  const found = registered();
  for (const check of ['alchemyfactory-ue4ss-needed', 'alchemyfactory-ue4ss-build',
    'alchemyfactory-requirements']) {
    for (const event of ['gamemode-activated', 'profile-did-change', 'mod-installed', 'mod-activated']) {
      assert.ok(found.tests.includes(`${check} ${event}`), `${check} ${event}`);
    }
  }
  assert.deepStrictEqual(found.settings, ['Mods']);
});

test('Install UE4SS is pinned to the mods page\'s toolbar by default', () => {
  const action = registered().actions.find((candidate) => candidate.icon === 'download');
  assert.ok(shown(action.title));
  assert.strictEqual(action.group, 'mod-icons');
  assert.deepStrictEqual(action.options, { pinned: true });
});

test('the setting: on until turned off; set at all, it\'s the player\'s choice', () => {
  const [[statePath, reducer]] = registered().reducers;
  assert.deepStrictEqual(statePath, ['settings', 'alchemyFactory']);
  assert.deepStrictEqual(reducer.defaults, { autoinstallUe4ss: true, autoinstallUe4ssChosen: false });
  for (const enabled of [false, true]) {
    const action = extension.setAutoinstallUe4ss(enabled);
    assert.deepStrictEqual(reducer.reducers[action.type](reducer.defaults, action.payload),
      { autoinstallUe4ss: enabled, autoinstallUe4ssChosen: true });
  }
});

test('the name the extension gave a mod is carried over to its reinstall or update', async () => {
  const [extractor] = registered().extractors;
  assert.deepStrictEqual(await extractor({ previous: { alchemyFactoryName: 'My Mod' } }),
    { alchemyFactoryName: 'My Mod' });
  assert.deepStrictEqual(await extractor({}), { alchemyFactoryName: undefined });
});

test('each installer knows its archives', async () => {
  const supported = async (check, files, game = 'alchemyfactory') =>
    (await check(files, game)).supported;
  assert.ok(await supported(testUe4ss, ue4ssZip));
  assert.ok(!(await supported(testUe4ss, gameLayoutZip)));
  assert.ok(!(await supported(testUe4ss, ue4ssZip, 'palworld')));
  assert.ok(await supported(testGameLayout, gameLayoutZip));
  assert.ok(!(await supported(testGameLayout, archive('Content/Stuff.txt', 'MyMod/Scripts/main.lua'))));
  assert.ok(await supported(testUe4ssMod, archive('MyMod/Scripts/main.lua')));
  assert.ok(await supported(testUe4ssMod, archive('Mods/Fast/dlls/main.dll')));
  assert.ok(!(await supported(testUe4ssMod, archive('Foo_P.pak'))));
  assert.ok(await supported(testUe4ssMod, archive('shared/MyLib/MyLib.lua')));
  assert.ok(!(await supported(testUe4ssMod, archive('shared/MyLib/notes.txt', 'shared/Top.lua'))));
  assert.ok(await supported(testContainers, archive('Foo_P.pak')));
  assert.ok(!(await supported(testContainers, archive('readme.txt'))));
  // save games and Cheat Engine tables, with documents at most
  assert.ok(await supported(testUnplaceable, archive('Slot1.sav', 'README.txt')));
  assert.ok(await supported(testUnplaceable, archive('Tables/Alchemy Factory.CT')));
  assert.ok(!(await supported(testUnplaceable, archive('Slot1.sav', 'Foo_P.pak'))));
  assert.ok(!(await supported(testUnplaceable, archive('README.txt'))));
  assert.ok(!(await supported(testUnplaceable, archive('Slot1.sav'), 'palworld')));
});

test('an archive with a FOMOD installer is left to Vortex\'s, whatever else it holds', async () => {
  const fomod = archive('fomod/ModuleConfig.xml', 'fomod/info.xml');
  for (const [check, files] of [
    [testUe4ss, ue4ssZip], [testGameLayout, gameLayoutZip],
    [testUe4ssMod, archive('MyMod/Scripts/main.lua')], [testContainers, variantsZip],
  ]) {
    assert.ok((await check(files, 'alchemyfactory')).supported);
    assert.ok(!(await check([...files, ...fomod], 'alchemyfactory')).supported);
  }
});

test('save games and Cheat Engine tables are refused, with where they go', async () => {
  const refusal = async (files) => {
    let message;
    await assert.rejects(installUnplaceable(files), (error) => {
      message = error.message;
      return error instanceof SetupError && shown(message);
    });
    return message;
  };
  const saveGames = await refusal(archive('Slot1.sav', 'README.txt'));
  const tables = await refusal(archive('Alchemy Factory.CT'));
  // each kind gets its own message, and an archive with both gets both
  assert.notStrictEqual(saveGames, tables);
  const both = await refusal(archive('Slot1.sav', 'Alchemy Factory.CT'));
  assert.ok(both.includes(saveGames) && both.includes(tables));
});

test('UE4SS: its loader beside the game, the rest in ue4ss', async () => {
  const result = await installUe4ss(ue4ssZip);
  const placed = copies(result);
  assert.strictEqual(placed['dwmapi.dll'], win64('dwmapi.dll'));
  assert.strictEqual(placed['ue4ss/UE4SS.dll'], win64('ue4ss', 'UE4SS.dll'));
  assert.strictEqual(placed['ue4ss/Mods/mods.txt'], win64('ue4ss', 'Mods', 'mods.txt'));
  assert.strictEqual(Object.keys(placed).length, ue4ssZip.filter((file) => !file.endsWith(path.sep)).length);
  assert.strictEqual(modTypeOf(result), UE4SS_TYPE);
  // not the pinned build's version: this archive may be another build
  assert.ok(!result.instructions.some((instruction) => instruction.key === 'version'));
});

test('UE4SS laid out flat, or in a folder of its own', async () => {
  const flat = copies(await installUe4ss(archive('UE4SS.dll', 'dwmapi.dll', 'UE4SS-settings.ini',
    'Mods/mods.txt')));
  assert.strictEqual(flat['dwmapi.dll'], win64('dwmapi.dll'));
  assert.strictEqual(flat['UE4SS-settings.ini'], win64('ue4ss', 'UE4SS-settings.ini'));
  assert.strictEqual(flat['Mods/mods.txt'], win64('ue4ss', 'Mods', 'mods.txt'));
  const wrapped = copies(await installUe4ss(archive('UE4SS_v3/dwmapi.dll', 'UE4SS_v3/ue4ss/UE4SS.dll',
    'UE4SS_v3/README.md')));
  assert.strictEqual(wrapped['UE4SS_v3/dwmapi.dll'], win64('dwmapi.dll'));
  assert.strictEqual(wrapped['UE4SS_v3/ue4ss/UE4SS.dll'], win64('ue4ss', 'UE4SS.dll'));
  assert.strictEqual(wrapped['UE4SS_v3/README.md'], undefined);
});

const attributeOf = (result, key) => result.instructions
  .find((instruction) => instruction.type === 'attribute' && instruction.key === key)?.value;

test('a mod that came with UE4SS, laid out as the game folder: the mod, without UE4SS', async () => {
  const result = await installUe4ss(archive('README.txt', 'AlchemyFactory/Binaries/Win64/dwmapi.dll',
    'AlchemyFactory/Binaries/Win64/ue4ss/UE4SS.dll', 'AlchemyFactory/Binaries/Win64/ue4ss/UE4SS-settings.ini',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/mods.txt',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/BPModLoaderMod/Scripts/main.lua',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/Pack/Scripts/main.lua',
    'AlchemyFactory/Content/Paks/Mods/Pack/Pack_P.pak'), 'C:\\staging\\Pack.installing');
  assert.deepStrictEqual(copies(result), {
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/Pack/Scripts/main.lua':
      win64('ue4ss', 'Mods', 'Pack', 'Scripts', 'main.lua'),
    'AlchemyFactory/Content/Paks/Mods/Pack/Pack_P.pak': paks('Mods', 'Pack', 'Pack_P.pak'),
  });
  // its mods.txt left out with the rest of UE4SS, so its mod gets an enabled.txt
  assert.deepStrictEqual(generated(result), [win64('ue4ss', 'Mods', 'Pack', 'enabled.txt')]);
  assert.strictEqual(attributeOf(result, 'alchemyFactoryBundledUe4ss'), true);
  // a mod: the default type
  assert.strictEqual(modTypeOf(result), '');
});

test('a mod that came with UE4SS as its release lays it out, or flat: the mod, without UE4SS',
  async () => {
    const released = copies(await installUe4ss(archive('dwmapi.dll', 'ue4ss/UE4SS.dll',
      'ue4ss/Mods/mods.txt', 'ue4ss/Mods/Speed/Scripts/main.lua', 'ue4ss/Mods/shared/UEHelpers/UEHelpers.lua',
      'ue4ss/Mods/shared/SpeedLib/SpeedLib.lua', 'Speed_P.pak'), 'C:\\staging\\Speed.installing'));
    assert.deepStrictEqual(released, {
      'ue4ss/Mods/Speed/Scripts/main.lua': win64('ue4ss', 'Mods', 'Speed', 'Scripts', 'main.lua'),
      'ue4ss/Mods/shared/SpeedLib/SpeedLib.lua': win64('ue4ss', 'Mods', 'shared', 'SpeedLib', 'SpeedLib.lua'),
      'Speed_P.pak': paks('~mods', 'Speed_P.pak'),
    });
    const flat = copies(await installUe4ss(archive('UE4SS.dll', 'dwmapi.dll', 'Mods/Flat/Scripts/main.lua',
      'Mods/Keybinds/Scripts/main.lua'), 'C:\\staging\\Flat.installing'));
    assert.deepStrictEqual(flat, {
      'Mods/Flat/Scripts/main.lua': win64('ue4ss', 'Mods', 'Flat', 'Scripts', 'main.lua'),
    });
  });

test('a mod that came with UE4SS: the player is told UE4SS was left out', () => {
  const notified = (attributes) => {
    const api = fakeApi(stateWith({ mods: { Pack: { id: 'Pack', state: 'installed', attributes } } }));
    extension.onDidInstallMod(api, 'alchemyfactory', 'Pack');
    return api.notifications.map((notification) => notification.message);
  };
  const [message, ...others] = notified({ customFileName: 'SpeedFreedom', alchemyFactoryBundledUe4ss: true });
  assert.ok(shown(message) && message.includes('SpeedFreedom'));
  assert.deepStrictEqual(others, []);
  assert.deepStrictEqual(notified({ customFileName: 'FastBelts' }), []);
});

test('the game layout: its game files as they are, nothing else', async () => {
  const result = await installGameLayout(gameLayoutZip);
  const placed = copies(result);
  assert.strictEqual(placed['AlchemyFactory/Content/Paks/~mods/MyMod_P.utoc'],
    paks('~mods', 'MyMod_P.utoc'));
  assert.strictEqual(placed['AlchemyFactory/Binaries/Win64/ue4ss/Mods/MyMod/Scripts/main.lua'],
    win64('ue4ss', 'Mods', 'MyMod', 'Scripts', 'main.lua'));
  assert.strictEqual(placed['manifest.json'], undefined);
  assert.strictEqual(placed['README.md'], undefined);
  assert.strictEqual(Object.keys(placed).length, 5);
  assert.deepStrictEqual(generated(result), []);
});

test('the game layout: an enabled.txt where a UE4SS mod lacks one, never UE4SS\'s mod list',
  async () => {
    const result = await installGameLayout(archive(
      'Pack/AlchemyFactory/Binaries/Win64/ue4ss/Mods/Other/Scripts/main.lua',
      'Pack/AlchemyFactory/Binaries/Win64/ue4ss/Mods/mods.txt'));
    const placed = copies(result);
    assert.strictEqual(placed['Pack/AlchemyFactory/Binaries/Win64/ue4ss/Mods/Other/Scripts/main.lua'],
      win64('ue4ss', 'Mods', 'Other', 'Scripts', 'main.lua'));
    assert.strictEqual(placed['Pack/AlchemyFactory/Binaries/Win64/ue4ss/Mods/mods.txt'], undefined);
    assert.deepStrictEqual(generated(result), [win64('ue4ss', 'Mods', 'Other', 'enabled.txt')]);
  });

test('a Lua mod, wherever it is in the archive', async () => {
  const result = await installUe4ssMod(archive('MyMod/Scripts/main.lua', 'MyMod/config.lua',
    'README.txt'), 'C:\\staging\\MyMod-12-1-0.installing');
  const placed = copies(result);
  assert.strictEqual(placed['MyMod/Scripts/main.lua'], win64('ue4ss', 'Mods', 'MyMod', 'Scripts', 'main.lua'));
  assert.strictEqual(placed['MyMod/config.lua'], win64('ue4ss', 'Mods', 'MyMod', 'config.lua'));
  assert.strictEqual(placed['README.txt'], undefined);
  assert.deepStrictEqual(generated(result), [win64('ue4ss', 'Mods', 'MyMod', 'enabled.txt')]);
});

test('a Lua mod at the archive\'s top is named for the archive', async () => {
  const placed = copies(await installUe4ssMod(archive('Scripts/main.lua', 'enabled.txt'),
    'C:\\staging\\Cool Mod-123-1-0-1700000000.installing'));
  assert.strictEqual(placed['Scripts/main.lua'], win64('ue4ss', 'Mods', 'CoolMod', 'Scripts', 'main.lua'));
  assert.strictEqual(placed['enabled.txt'], win64('ue4ss', 'Mods', 'CoolMod', 'enabled.txt'));
  // only Nexus Mods' ids at the end go, not a digit in the name; an archive from elsewhere keeps
  // its name
  for (const [folder, name] of [
    ['X-2 Speed-123-1-0-1700000000.installing', 'X2Speed'],
    ['X-2 Speed.installing', 'X2Speed'],
    ['Speed v1.2.installing', 'Speedv12'],
    ['-123.installing', 'Mod'],
  ]) {
    const named = copies(await installUe4ssMod(archive('Scripts/main.lua'), `C:\\staging\\${folder}`));
    assert.strictEqual(named['Scripts/main.lua'], win64('ue4ss', 'Mods', name, 'Scripts', 'main.lua'), folder);
  }
});

test('a Lua mod at the archive\'s top: its paks and shared modules where they load', async () => {
  const placed = copies(await installUe4ssMod(archive('Scripts/main.lua', 'Scripts/shared/util.lua',
    'shared/MyLib/MyLib.lua', 'Assets_P.pak', 'Assets_P.utoc', 'Assets_P.ucas'),
  'C:\\staging\\Cool Mod-123-1-0-1700000000.installing'));
  assert.deepStrictEqual(placed, {
    'Scripts/main.lua': win64('ue4ss', 'Mods', 'CoolMod', 'Scripts', 'main.lua'),
    // the mod's own, in its Scripts folder
    'Scripts/shared/util.lua': win64('ue4ss', 'Mods', 'CoolMod', 'Scripts', 'shared', 'util.lua'),
    'shared/MyLib/MyLib.lua': win64('ue4ss', 'Mods', 'shared', 'MyLib', 'MyLib.lua'),
    'Assets_P.pak': paks('~mods', 'Assets_P.pak'),
    'Assets_P.utoc': paks('~mods', 'Assets_P.utoc'),
    'Assets_P.ucas': paks('~mods', 'Assets_P.ucas'),
  });
});

test('a UE4SS mod\'s paks in its folder go to ~mods', async () => {
  const placed = copies(await installUe4ssMod(archive('MyMod/Scripts/main.lua', 'MyMod/Paks/MyMod_P.pak'),
    'C:\\staging\\MyMod.installing'));
  assert.strictEqual(placed['MyMod/Paks/MyMod_P.pak'], paks('~mods', 'MyMod_P.pak'));
});

test('a C++ mod with a shared Lua module and a container', async () => {
  const placed = copies(await installUe4ssMod(archive('Mods/Fast/dlls/main.dll',
    'Mods/shared/FastLib/FastLib.lua', 'Paks/Fast_P.pak'), 'C:\\staging\\Fast.installing'));
  assert.strictEqual(placed['Mods/Fast/dlls/main.dll'], win64('ue4ss', 'Mods', 'Fast', 'dlls', 'main.dll'));
  assert.strictEqual(placed['Mods/shared/FastLib/FastLib.lua'],
    win64('ue4ss', 'Mods', 'shared', 'FastLib', 'FastLib.lua'));
  assert.strictEqual(placed['Paks/Fast_P.pak'], paks('~mods', 'Fast_P.pak'));
});

test('a library: shared Lua modules alone, with no enabled.txt', async () => {
  const result = await installUe4ssMod(archive('MyLib-1-0/shared/MyLib/MyLib.lua',
    'MyLib-1-0/shared/MyLib/util/strings.lua', 'MyLib-1-0/README.md'),
  'C:\\staging\\MyLib-1-0.installing');
  assert.deepStrictEqual(copies(result), {
    'MyLib-1-0/shared/MyLib/MyLib.lua': win64('ue4ss', 'Mods', 'shared', 'MyLib', 'MyLib.lua'),
    'MyLib-1-0/shared/MyLib/util/strings.lua':
      win64('ue4ss', 'Mods', 'shared', 'MyLib', 'util', 'strings.lua'),
  });
  assert.deepStrictEqual(generated(result), []);
});

test('an archive\'s metadata: its Thunderstore manifest.json nearest the top', async () => {
  const destination = 'C:\\staging\\MyMod_1.2.0.installing';
  onDisk({
    [`${destination}\\manifest.json`]: '\uFEFF' + JSON.stringify({
      name: 'My_Mod', version_number: '1.2.0', website_url: '', description: 'A mod.',
      dependencies: [],
    }),
    [`${destination}\\Pack\\MyMod\\manifest.json`]: JSON.stringify({ name: 'Other', version_number: '9.9.9' }),
  });
  const metadata = { name: 'My_Mod', title: 'My Mod', version: '1.2.0', description: 'A mod.' };
  assert.deepStrictEqual(
    await extension.readMetadata(archive('Pack/MyMod/manifest.json', 'manifest.json'), destination),
    metadata);
  assert.deepStrictEqual(await extension.readMetadata(archive('Scripts/main.lua'), destination), {});
  const result = await installGameLayout(gameLayoutZip, destination);
  assert.deepStrictEqual(result.instructions[0],
    { type: 'attribute', key: 'alchemyFactoryMetadata', value: metadata });
  onDisk();
});

test('a manifest.json without a version_number is a mod\'s own file, not Thunderstore\'s', async () => {
  const destination = 'C:\\staging\\MyMod.installing';
  onDisk({
    [`${destination}\\MyMod\\manifest.json`]: JSON.stringify({ name: 'config', description: 'Data' }),
    [`${destination}\\MyMod\\Deeper\\manifest.json`]:
      JSON.stringify({ name: 'Real_Mod', version_number: '2.0.0' }),
  });
  assert.deepStrictEqual(await extension.readMetadata(
    archive('MyMod/manifest.json', 'MyMod/Deeper/manifest.json'), destination),
  { name: 'Real_Mod', title: 'Real Mod', version: '2.0.0' });
  onDisk();
});

test('an archive\'s metadata: the UE4SS build a C++ mod was built against, if it is one', async () => {
  const destination = 'C:\\staging\\Cpp.installing';
  for (const [ue4ssVersion, expected] of [
    ['3.0.1-1190-gabcdef12', '3.0.1-1190-gabcdef12'], ['3.0.1-1190', '3.0.1-1190'], ['latest', undefined],
    [1190, undefined],
  ]) {
    onDisk({ [`${destination}\\manifest.json`]:
      JSON.stringify({ name: 'Cpp', version_number: '1.0.0', ue4ss_version: ue4ssVersion }) });
    const metadata = await extension.readMetadata(archive('manifest.json'), destination);
    assert.strictEqual(metadata.ue4ss, expected);
  }
  onDisk();
});

test('an archive\'s metadata: the mods its manifest.json requires, except UE4SS', async () => {
  const destination = 'C:\\staging\\Vault.installing';
  onDisk({
    [`${destination}\\manifest.json`]: JSON.stringify({
      name: 'AlchemistsVault', version_number: '0.8.4',
      dependencies: ['AlchemistsTools-AlchemistsLibrary-0.2.5', 'UE4SS-RE-UE4SS-3.0.1', 'not a dependency', 7],
    }),
  });
  const metadata = await extension.readMetadata(archive('manifest.json'), destination);
  assert.deepStrictEqual(metadata.requirements, [{ name: 'AlchemistsLibrary', version: '0.2.5' }]);
  onDisk();
});

test('containers: to ~mods, or LogicMods', async () => {
  const placed = copies(await installContainers(archive('Foo_P.pak', 'sub/Foo_P.utoc',
    'sub/Foo_P.ucas', 'LogicMods/Bar/Bar.pak', 'readme.txt')));
  assert.deepStrictEqual(placed, {
    'Foo_P.pak': paks('~mods', 'Foo_P.pak'),
    'sub/Foo_P.utoc': paks('~mods', 'Foo_P.utoc'),
    'sub/Foo_P.ucas': paks('~mods', 'Foo_P.ucas'),
    'LogicMods/Bar/Bar.pak': paks('LogicMods', 'Bar', 'Bar.pak'),
  });
});

test('containers in one folder: no question', async () => {
  const api = fakeApi(stateWith());
  const result = await installContainers(archive('~mods/czech/cestina_P.pak',
    '~mods/czech/cestina_P.ucas', '~mods/czech/cestina_P.utoc'), undefined, { api });
  assert.strictEqual(Object.keys(copies(result)).length, 3);
  assert.strictEqual(choiceOf(result), undefined);
  assert.deepStrictEqual(api.dialogs, []);
});

test('versions in folders: the player picks one, which is recorded', async () => {
  const api = fakeApi(stateWith(), { dialog: () => ({ action: 'Install', input: { 0: false, 1: true } }) });
  const result = await installContainers(variantsZip, undefined, { api });
  assert.deepStrictEqual(copies(result), {
    'MaxYield/X5/MaxYield_P.pak': paks('~mods', 'MaxYield_P.pak'),
    'MaxYield/X5/MaxYield_P.utoc': paks('~mods', 'MaxYield_P.utoc'),
    'MaxYield/X5/MaxYield_P.ucas': paks('~mods', 'MaxYield_P.ucas'),
  });
  assert.deepStrictEqual(choiceOf(result), { type: 'alchemyfactory-folders', folders: ['maxyield/x5'] });
  // the same file names: one choice, the first by default
  const [content] = api.dialogs;
  assert.deepStrictEqual(content.choices.map((choice) => [choice.text, choice.value]),
    [['MaxYield/X2', true], ['MaxYield/X5', false]]);
  assert.strictEqual(content.checkboxes, undefined);
});

test('containers go to ~mods, or to LogicMods from a LogicMods folder, as mods of the default type',
  async () => {
  const pakOnly = await installContainers(archive('Foo/Foo_P.pak', 'Foo/Foo_P.utoc', 'Foo/Foo_P.ucas'));
  assert.strictEqual(modTypeOf(pakOnly), '');
  assert.deepStrictEqual(copies(pakOnly), {
    'Foo/Foo_P.pak': paks('~mods', 'Foo_P.pak'),
    'Foo/Foo_P.utoc': paks('~mods', 'Foo_P.utoc'),
    'Foo/Foo_P.ucas': paks('~mods', 'Foo_P.ucas'),
  });
  const logicOnly = await installContainers(archive('LogicMods/Bar/Bar.pak'));
  assert.strictEqual(modTypeOf(logicOnly), '');
  assert.deepStrictEqual(copies(logicOnly), { 'LogicMods/Bar/Bar.pak': paks('LogicMods', 'Bar', 'Bar.pak') });
  const both = await installContainers(archive('Foo_P.pak', 'LogicMods/Bar.pak'));
  assert.strictEqual(modTypeOf(both), '');
  assert.strictEqual(copies(both)['Foo_P.pak'], paks('~mods', 'Foo_P.pak'));
});

test('containers alone laid out as the game folder go to ~mods too', async () => {
  // as Max Yield is; and as Steel Drawer is, with a folder of tools beside
  const maxYield = archive('AlchemyFactory/', 'AlchemyFactory/Content/', 'AlchemyFactory/Content/Paks/',
    'AlchemyFactory/Content/Paks/MaxYield_P.pak', 'AlchemyFactory/Content/Paks/MaxYield_P.utoc',
    'AlchemyFactory/Content/Paks/MaxYield_P.ucas');
  const steelDrawer = archive('AlchemyFactory/Content/Paks/SteelDrawer_P.pak', 'Tools/patch.ps1');
  for (const files of [maxYield, steelDrawer]) {
    assert.ok(!(await testGameLayout(files, 'alchemyfactory')).supported);
    assert.ok((await testContainers(files, 'alchemyfactory')).supported);
  }
  const result = await installContainers(maxYield);
  assert.strictEqual(modTypeOf(result), '');
  assert.deepStrictEqual(Object.values(copies(result)),
    [paks('~mods', 'MaxYield_P.pak'), paks('~mods', 'MaxYield_P.utoc'), paks('~mods', 'MaxYield_P.ucas')]);
  // with anything else of the game's, as it is
  assert.ok((await testGameLayout(archive('AlchemyFactory/Content/Paks/A_P.pak',
    'AlchemyFactory/Content/Movies/Intro.bk2'), 'alchemyfactory')).supported);
});

test('a mod of containers alone that came with UE4SS: the mod, without UE4SS', async () => {
  const result = await installUe4ss(archive('AlchemyFactory/Binaries/Win64/dwmapi.dll',
    'AlchemyFactory/Binaries/Win64/ue4ss/UE4SS.dll', 'AlchemyFactory/Content/Paks/Big_P.pak'),
  'C:\\staging\\Big.installing');
  assert.deepStrictEqual(copies(result), { 'AlchemyFactory/Content/Paks/Big_P.pak': paks('~mods', 'Big_P.pak') });
  assert.strictEqual(modTypeOf(result), '');
  assert.strictEqual(attributeOf(result, 'alchemyFactoryBundledUe4ss'), true);
});

test('the mod types: UE4SS\'s alone, deployed into Binaries/Win64, given only by its installer',
  async () => {
    const { modTypes } = registered();
    assert.deepStrictEqual(modTypes.map((type) => [type.id, type.options.name]), [[UE4SS_TYPE, 'UE4SS']]);
    const [type] = modTypes;
    assert.strictEqual(type.getPath(), path.join('C:\\game', win64()));
    // its mods merged into that folder, as the game's are into the game folder
    assert.strictEqual(type.options.mergeMods, undefined);
    assert.ok(type.isSupported('alchemyfactory') && !type.isSupported('palworld'));
    assert.strictEqual(await type.test([]), false);
  });

test('UE4SS is placed relative to Binaries/Win64, every other mod relative to the game folder', async () => {
  const destinations = (result) => result.instructions
    .filter((instruction) => ['copy', 'generatefile'].includes(instruction.type))
    .map((instruction) => instruction.destination);
  const ue4ss = await installUe4ss(archive('dwmapi.dll', 'ue4ss/UE4SS.dll'));
  assert.deepStrictEqual(destinations(ue4ss), ['dwmapi.dll', path.join('ue4ss', 'UE4SS.dll')]);
  const lua = await installUe4ssMod(archive('MyMod/Scripts/main.lua'), 'C:\\staging\\MyMod.installing');
  assert.strictEqual(modTypeOf(lua), '');
  assert.deepStrictEqual(destinations(lua), [win64('ue4ss', 'Mods', 'MyMod', 'Scripts', 'main.lua'),
    win64('ue4ss', 'Mods', 'MyMod', 'enabled.txt')]);
  assert.deepStrictEqual(destinations(await installContainers(archive('Foo_P.pak'))), [paks('~mods', 'Foo_P.pak')]);
  // laid out as the game folder, its names in any case: the game's folders as the game has them
  const lowerCase = await installGameLayout(archive(
    'alchemyfactory/binaries/win64/ue4ss/mods/Low/Scripts/main.lua',
    'alchemyfactory/binaries/win64/ue4ss/mods/Low/enabled.txt',
    'alchemyfactory/content/Movies/Intro.bk2'));
  assert.strictEqual(modTypeOf(lowerCase), '');
  assert.deepStrictEqual(destinations(lowerCase), [
    win64('ue4ss', 'Mods', 'Low', 'Scripts', 'main.lua'), win64('ue4ss', 'Mods', 'Low', 'enabled.txt'),
    path.join('AlchemyFactory', 'content', 'Movies', 'Intro.bk2'),
  ]);
  // in two folders: still one mod, placed from the game folder
  const both = await installUe4ssMod(archive('MyMod/Scripts/main.lua', 'MyMod_P.pak'),
    'C:\\staging\\MyMod.installing');
  assert.strictEqual(modTypeOf(both), '');
  assert.ok(destinations(both).includes(paks('~mods', 'MyMod_P.pak')));
});

test('the installers record whether a mod needs UE4SS: files in ue4ss/Mods or LogicMods', async () => {
  const needs = (result) => attributeOf(result, 'alchemyFactoryNeedsUe4ss');
  assert.strictEqual(needs(await installUe4ssMod(archive('MyMod/Scripts/main.lua'), 'C:\\staging\\MyMod.installing')),
    true);
  assert.strictEqual(needs(await installUe4ssMod(archive('shared/MyLib/MyLib.lua'), 'C:\\staging\\MyLib.installing')),
    true);
  assert.strictEqual(needs(await installContainers(archive('Foo_P.pak'))), false);
  assert.strictEqual(needs(await installContainers(archive('LogicMods/Bar.pak'))), true);
  assert.strictEqual(needs(await installGameLayout(archive('AlchemyFactory/Content/Movies/Intro.bk2'))), false);
  assert.strictEqual(needs(await installGameLayout(gameLayoutZip)), true);
  // UE4SS itself isn't a mod
  assert.strictEqual(needs(await installUe4ss(ue4ssZip)), undefined);
});

test('UE4SS\'s own files in a mod are left out, and the player told; an archive of only those is '
  + 'refused', async () => {
  // laid out as the game folder: its loader, settings, mod list, a built-in mod and a built-in library
  const layout = await installGameLayout(archive(
    'AlchemyFactory/Binaries/Win64/dwmapi.dll',
    'AlchemyFactory/Binaries/Win64/ue4ss/UE4SS-settings.ini',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/mods.txt',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/ConsoleEnablerMod/enabled.txt',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/shared/UEHelpers/UEHelpers.lua',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/MyMod/Scripts/main.lua'));
  assert.deepStrictEqual(copies(layout), {
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/MyMod/Scripts/main.lua':
      win64('ue4ss', 'Mods', 'MyMod', 'Scripts', 'main.lua'),
  });
  assert.deepStrictEqual(generated(layout), [win64('ue4ss', 'Mods', 'MyMod', 'enabled.txt')]);
  assert.strictEqual(attributeOf(layout, 'alchemyFactoryBundledUe4ss'), true);
  // a UE4SS mod with a built-in library beside it
  const lua = await installUe4ssMod(archive('MyMod/Scripts/main.lua', 'shared/UEHelpers/UEHelpers.lua',
    'shared/MyLib/MyLib.lua'), 'C:\\staging\\MyMod.installing');
  assert.deepStrictEqual(Object.keys(copies(lua)), ['MyMod/Scripts/main.lua', 'shared/MyLib/MyLib.lua']);
  assert.strictEqual(attributeOf(lua, 'alchemyFactoryBundledUe4ss'), true);
  // only its mod list: left out without a word
  const listed = await installGameLayout(archive(
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/MyMod/Scripts/main.lua',
    'AlchemyFactory/Binaries/Win64/ue4ss/Mods/mods.txt'));
  assert.strictEqual(attributeOf(listed, 'alchemyFactoryBundledUe4ss'), undefined);
  // only UE4SS's own files: refused, with a message
  const refused = (error) => error instanceof SetupError && shown(error.message);
  await assert.rejects(installGameLayout(archive('AlchemyFactory/Binaries/Win64/ue4ss/UE4SS-settings.ini')),
    refused);
  await assert.rejects(installUe4ssMod(archive('shared/UEHelpers/UEHelpers.lua'),
    'C:\\staging\\UEHelpers.installing'), refused);
});

test('versions in folders: a choice made before is used, unasked', async () => {
  const api = fakeApi(stateWith());
  const result = await installContainers(variantsZip, undefined,
    { api, choices: { type: 'alchemyfactory-folders', folders: ['maxyield/x5'] } });
  assert.deepStrictEqual(Object.keys(copies(result)),
    ['MaxYield/X5/MaxYield_P.pak', 'MaxYield/X5/MaxYield_P.utoc', 'MaxYield/X5/MaxYield_P.ucas']);
  assert.deepStrictEqual(api.dialogs, []);
});

test('versions in folders, reinstalled: the replaced mod\'s choice is used once', async () => {
  const choice = { type: 'alchemyfactory-folders', folders: ['maxyield/x5'] };
  const mods = { MaxYield: { state: 'installed', attributes: { installerChoices: choice } } };
  // removing it for good keeps nothing
  await extension.onWillRemoveMods(fakeApi(stateWith({ mods })), 'alchemyfactory', ['MaxYield'], undefined);
  assert.strictEqual(extension.replacedChoices('C:\\staging\\MaxYield.installing'), undefined);
  await extension.onWillRemoveMods(fakeApi(stateWith({ mods })), 'alchemyfactory', ['MaxYield'],
    { willBeReplaced: true });
  assert.deepStrictEqual(extension.replacedChoices('C:\\staging\\MaxYield.installing'), choice);
  // a later fresh install asks again
  assert.strictEqual(extension.replacedChoices('C:\\staging\\MaxYield.installing'), undefined);
});

test('versions in folders, installing unattended: the first', async () => {
  const api = fakeApi(stateWith());
  const result = await installContainers(variantsZip, undefined, { api, unattended: true });
  assert.deepStrictEqual(Object.keys(copies(result)),
    ['MaxYield/X2/MaxYield_P.pak', 'MaxYield/X2/MaxYield_P.utoc', 'MaxYield/X2/MaxYield_P.ucas']);
});

test('folders with different file names: any of them, all by default; LogicMods always', async () => {
  const api = fakeApi(stateWith(), { dialog: () => ({ action: 'Install', input: { 0: true, 1: false } }) });
  const result = await installContainers(archive('Main/Main_P.pak', 'Optional/Extra_P.pak',
    'LogicMods/BP/BP.pak'), undefined, { api });
  assert.deepStrictEqual(copies(result), {
    'Main/Main_P.pak': paks('~mods', 'Main_P.pak'),
    'LogicMods/BP/BP.pak': paks('LogicMods', 'BP', 'BP.pak'),
  });
  const [content] = api.dialogs;
  assert.deepStrictEqual(content.checkboxes.map((checkbox) => [checkbox.text, checkbox.value]),
    [['Main', true], ['Optional', true]]);
});

test('versions in folders: canceling, or choosing none, installs nothing', async () => {
  for (const answer of [{ action: 'Cancel', input: {} }, { action: 'Install', input: {} }]) {
    const api = fakeApi(stateWith(), { dialog: () => answer });
    await assert.rejects(installContainers(variantsZip, undefined, { api }), UserCanceled);
  }
});

test('a UE4SS mod\'s containers in versioned folders: the player picks', async () => {
  const api = fakeApi(stateWith(), { dialog: () => ({ action: 'Install', input: { 1: true } }) });
  const placed = copies(await installUe4ssMod(archive('Mods/Fast/Scripts/main.lua',
    'Paks/Slow/Fast_P.pak', 'Paks/Quick/Fast_P.pak'), 'C:\\staging\\Fast.installing', { api }));
  assert.deepStrictEqual(placed, {
    'Mods/Fast/Scripts/main.lua': win64('ue4ss', 'Mods', 'Fast', 'Scripts', 'main.lua'),
    'Paks/Slow/Fast_P.pak': paks('~mods', 'Fast_P.pak'),
  });
});

// fillAttributes over these mods, with the game's categories from Nexus Mods
function fill(mods, modIds, justInstalled) {
  const state = stateWith({ mods });
  state.persistent.categories = {
    alchemyfactory: { 1: { name: 'Alchemy Factory' }, 2: { name: 'Miscellaneous' } },
  };
  const api = fakeApi(state);
  extension.fillAttributes(api, modIds, justInstalled);
  return api.dispatched.map(({ modId, attributes }) => ({ modId, attributes }));
}

const myModMetadata = { title: 'My Mod', version: '0.8.4', description: 'A mod.' };

test('what the mods list shows is filled in where it\'s empty, and only from the archive\'s metadata',
  () => {
    const mods = {
      Manifest: { state: 'installed', attributes: { fileName: 'My_Mod-0.8.4.zip', alchemyFactoryMetadata: myModMetadata } },
      Named: { state: 'installed', attributes: { fileName: 'FrameRate_0.2.0.zip' } },
      Renamed: {
        state: 'installed',
        attributes: { customFileName: 'Mine', source: 'unsupported', alchemyFactoryMetadata: myModMetadata },
      },
      FromNexus: {
        state: 'installed',
        attributes: {
          source: 'nexus', fileId: 1, version: '2.0', logicalFileName: 'Fast Belts', category: 2,
          fileName: 'Fast Belts-12-2-0-1700000000.zip',
        },
      },
      Installing: { state: 'installing', attributes: { fileName: 'Other_1.0.zip' } },
    };
    assert.deepStrictEqual(fill(mods, Object.keys(mods).concat('Removed')), [
      {
        modId: 'Manifest',
        attributes: {
          customFileName: 'My Mod', alchemyFactoryName: 'My Mod', version: '0.8.4',
          description: 'A mod.', shortDescription: 'A mod.', category: 2, source: 'unsupported',
        },
      },
      // nothing from the archive's name
      { modId: 'Named', attributes: { category: 2, source: 'unsupported' } },
      // the name the player gave kept
      {
        modId: 'Renamed',
        attributes: { version: '0.8.4', description: 'A mod.', shortDescription: 'A mod.', category: 2 },
      },
    ]);
  });

test('just installed, the archive\'s metadata replaces what Vortex made up; Nexus Mods\' stays', () => {
  const mods = {
    Manifest: {
      state: 'installed',
      attributes: {
        logicalFileName: 'My_Mod-0.8.4', version: '0.8', category: 2,
        alchemyFactoryMetadata: myModMetadata,
      },
    },
    FromNexus: {
      state: 'installed',
      attributes: {
        source: 'nexus', version: '2.0', logicalFileName: 'Fast Belts', category: 2,
        alchemyFactoryMetadata: { title: 'FastBelts', version: '1.9' },
      },
    },
  };
  assert.deepStrictEqual(fill(mods, ['Manifest'], true), [{
    modId: 'Manifest',
    attributes: {
      customFileName: 'My Mod', alchemyFactoryName: 'My Mod', description: 'A mod.',
      shortDescription: 'A mod.', source: 'unsupported', version: '0.8.4',
    },
  }]);
  assert.deepStrictEqual(fill(mods, ['FromNexus'], true), []);
});

test('a mod whose source Vortex couldn\'t find ("unknown") is filled in as if it had none', () => {
  const mods = {
    Unknown: {
      state: 'installed',
      attributes: { source: 'unknown', fileName: 'My_Mod-0.8.4.zip', category: 2, alchemyFactoryMetadata: myModMetadata },
    },
  };
  assert.deepStrictEqual(fill(mods, ['Unknown'], true), [{
    modId: 'Unknown',
    attributes: {
      customFileName: 'My Mod', alchemyFactoryName: 'My Mod', version: '0.8.4', description: 'A mod.',
      shortDescription: 'A mod.', source: 'unsupported',
    },
  }]);
});

test('updated, a mod keeps the name the player gave it, and takes the archive\'s new one otherwise',
  () => {
    const newMetadata = { title: 'My Mod Plus', version: '0.9.0' };
    // Vortex carried the names (and the category) over from the previous version
    const mods = {
      PlayerNamed: {
        state: 'installed',
        attributes: {
          customFileName: 'Mine', alchemyFactoryName: 'My Mod', source: 'unsupported',
          category: 2, alchemyFactoryMetadata: newMetadata,
        },
      },
      ExtensionNamed: {
        state: 'installed',
        attributes: {
          customFileName: 'My Mod', alchemyFactoryName: 'My Mod', source: 'unsupported',
          category: 2, alchemyFactoryMetadata: newMetadata,
        },
      },
    };
    assert.deepStrictEqual(fill(mods, ['PlayerNamed', 'ExtensionNamed'], true), [
      { modId: 'PlayerNamed', attributes: { version: '0.9.0' } },
      {
        modId: 'ExtensionNamed',
        attributes: { customFileName: 'My Mod Plus', alchemyFactoryName: 'My Mod Plus', version: '0.9.0' },
      },
    ]);
  });

test('a UE4SS installed outside Vortex: the player is told, and warned if it isn\'t the pinned build',
  async () => {
    const notify = async (build) => {
      const dll = path.join('C:\\game', win64('ue4ss', 'UE4SS.dll'));
      onDisk({ [dll]: build });
      const api = fakeApi(stateWith());
      await extension.notifyOutsideUe4ss(api, dll);
      onDisk();
      return api.notifications;
    };
    const [pinned] = await notify('the pinned build');
    assert.strictEqual(pinned.type, 'info');
    assert.ok(shown(pinned.title) && shown(pinned.message));
    assert.ok(pinned.allowSuppress);
    const [other] = await notify('another build');
    assert.strictEqual(other.type, 'warning');
    assert.ok(shown(other.title) && shown(other.message));
    assert.ok(other.allowSuppress);
    assert.notStrictEqual(other.id, pinned.id);
  });

test('set up: UE4SS installed when the game has none', async () => {
  onDisk();
  const api = fakeApi(stateWith({ downloads: pinnedDownload }), { onEmit: installsAs('NewUE4SS') });
  await extension.ensureUe4ss(api, { path: 'C:\\game' });
  assert.deepStrictEqual(api.emitted, ['start-install-download']);
  assert.ok(api.dispatched.some((action) =>
    action.modId === 'NewUE4SS' && action.attributes.version === '3.0.1-1181-g83330635'));
  assert.deepStrictEqual(api.enabled, [{ modIds: ['NewUE4SS'], enabled: true }]);
});

test('Autoinstall UE4SS turned on: UE4SS installed at once; turned off, or another game managed: '
  + 'nothing', async () => {
  onDisk();
  const api = fakeApi(stateWith({ downloads: pinnedDownload }), { onEmit: installsAs('NewUE4SS') });
  await extension.onAutoinstallChanged(api, false, true);
  assert.deepStrictEqual(api.emitted, ['start-install-download']);
  for (const [state, previous, current] of [
    [stateWith({ downloads: pinnedDownload }), true, false],
    [stateWith({ downloads: pinnedDownload }), true, true],
    [stateWith({ downloads: pinnedDownload, active: 'palworld' }), false, true],
  ]) {
    const unchanged = fakeApi(state, { onEmit: installsAs('NewUE4SS') });
    await extension.onAutoinstallChanged(unchanged, previous, current);
    assert.deepStrictEqual(unchanged.emitted, []);
  }
});

// a UE4SS installed outside Vortex, as UE4SS 3 lays it out, and flat (with the other loader)
const outsideUe4ss = { [path.join('C:\\game', win64('ue4ss', 'UE4SS.dll'))]: 'the pinned build' };
const flatUe4ss = {
  [path.join('C:\\game', win64('UE4SS.dll'))]: 'another build',
  [path.join('C:\\game', win64('xinput1_3.dll'))]: 'its loader',
};
const onDiskNow = (file) => disk.has(diskKey(path.join('C:\\game', file)));

test('set up: nothing installed when Vortex has UE4SS, even disabled', async () => {
  onDisk(outsideUe4ss);
  const api = fakeApi(stateWith({ mods: { UE4SS: ue4ssMod() }, downloads: pinnedDownload }),
    { onEmit: installsAs('NewUE4SS') });
  await extension.ensureUe4ss(api, { path: 'C:\\game' });
  assert.deepStrictEqual(api.emitted, []);
  assert.deepStrictEqual(api.notifications, []);
  onDisk();
});

test('set up: a UE4SS installed outside Vortex is left alone while Autoinstall UE4SS is off',
  async () => {
    for (const files of [outsideUe4ss, flatUe4ss]) {
      onDisk(files);
      const api = fakeApi(stateWith({
        downloads: pinnedDownload, settings: { autoinstallUe4ss: false, autoinstallUe4ssChosen: true },
      }), { onEmit: installsAs('NewUE4SS') });
      await extension.ensureUe4ss(api, { path: 'C:\\game' });
      assert.deepStrictEqual(api.emitted, []);
      assert.strictEqual(api.notifications.length, 1);
      assert.strictEqual(api.notifications[0].actions, undefined);
    }
    onDisk();
  });

test('set up: a UE4SS installed outside Vortex, with the setting on by default: the player is asked',
  async () => {
    const asked = async (files) => {
      onDisk(files);
      const api = fakeApi(stateWith({ downloads: pinnedDownload }), { onEmit: installsAs('NewUE4SS') });
      await extension.ensureUe4ss(api, { path: 'C:\\game' });
      assert.deepStrictEqual(api.emitted, []);
      const [question] = api.notifications;
      assert.ok(shown(question.title) && shown(question.message));
      assert.strictEqual(question.actions.length, 2);
      assert.ok(question.actions.every((action) => shown(action.title)));
      return { api, question };
    };
    // the pinned build: Leave it turns the setting off
    const left = await asked(outsideUe4ss);
    assert.strictEqual(left.question.type, 'info');
    await left.question.actions[1].action(() => {});
    assert.deepStrictEqual(left.api.dispatched.map((action) => action.payload), [{ enabled: false }]);
    assert.deepStrictEqual(left.api.emitted, []);
    // another build: Manage installs the pinned one (its deploy sets the old one aside)
    const managed = await asked(flatUe4ss);
    assert.strictEqual(managed.question.type, 'warning');
    await managed.question.actions[0].action(() => {});
    assert.deepStrictEqual(managed.api.dispatched[0].payload, { enabled: true });
    assert.deepStrictEqual(managed.api.emitted, ['start-install-download']);
    assert.deepStrictEqual(managed.api.enabled, [{ modIds: ['NewUE4SS'], enabled: true }]);
    onDisk();
  });

// a did-deploy deployment: by mod type, each file relative to its type's folder (`target`, each mod's
// subfolder in it, is empty: both types merge their mods)
const deploymentOf = (byType) => Object.fromEntries(Object.entries(byType)
  .map(([typeId, files]) => [typeId, files.map((relPath) => ({ relPath, target: '' }))]));
const vortexUe4ss = {
  [UE4SS_TYPE]: ['dwmapi.dll', path.join('ue4ss', 'UE4SS.dll'), path.join('ue4ss', 'Mods', 'mods.txt')],
};

test('each deploy with Vortex\'s UE4SS sets aside what would load the old one beside it', async () => {
  onDisk(flatUe4ss);
  const api = fakeApi(stateWith());
  await extension.onDidDeploy(api, 'profile', deploymentOf(vortexUe4ss));
  assert.ok(!onDiskNow(win64('UE4SS.dll')) && !onDiskNow(win64('xinput1_3.dll')));
  assert.ok(onDiskNow(win64('UE4SS.dll.vortex_backup')) && onDiskNow(win64('xinput1_3.dll.vortex_backup')));
  // a purge puts them back; the next deploy sets them aside again
  onDisk(flatUe4ss);
  await extension.onDidDeploy(api, 'profile', deploymentOf(vortexUe4ss));
  assert.ok(!onDiskNow(win64('xinput1_3.dll')) && onDiskNow(win64('xinput1_3.dll.vortex_backup')));
  // deployed without Vortex's UE4SS (disabled, say): put back
  await extension.onDidDeploy(api, 'profile', deploymentOf({
    '': [win64('ue4ss', 'Mods', 'FrameRate', 'enabled.txt')],
  }));
  assert.ok(onDiskNow(win64('UE4SS.dll')) && onDiskNow(win64('xinput1_3.dll')));
  assert.ok(!onDiskNow(win64('UE4SS.dll.vortex_backup')));
  onDisk();
});

test('a deploy never touches a file Vortex deployed, nor another game\'s', async () => {
  // a UE4SS in Vortex whose loader is xinput1_3.dll, or that loader from a mod of the game folder
  for (const deployment of [
    { [UE4SS_TYPE]: ['xinput1_3.dll', path.join('ue4ss', 'UE4SS.dll')] },
    { [UE4SS_TYPE]: [path.join('ue4ss', 'UE4SS.dll')], '': [win64('xinput1_3.dll')] },
  ]) {
    onDisk(flatUe4ss);
    await extension.onDidDeploy(fakeApi(stateWith()), 'profile', deploymentOf(deployment));
    assert.ok(onDiskNow(win64('xinput1_3.dll')) && !onDiskNow(win64('UE4SS.dll')));
  }
  onDisk(flatUe4ss);
  await extension.onDidDeploy(fakeApi(stateWith()), 'other', deploymentOf(vortexUe4ss));
  assert.ok(onDiskNow(win64('UE4SS.dll')) && onDiskNow(win64('xinput1_3.dll')));
  onDisk();
});

test('the pinned build\'s download is shown as UE4SS, not as Nexus Mods has the same zip', async () => {
  const [, extractor] = registered().extractors;
  const download = { localPath: extension.UE4SS.zip, game: ['alchemyfactory'] };
  const attributes = await extractor({ download, meta: { logicalFileName: 'UE4SS for Alchemy Factory' } });
  assert.strictEqual(attributes.customFileName, 'UE4SS');
  assert.strictEqual(attributes.version, '3.0.1-1181-g83330635');
  assert.strictEqual(attributes.source, 'website');
  for (const other of [{ ...download, localPath: 'UE4SS_other.zip' }, { ...download, game: ['palworld'] }, undefined]) {
    assert.deepStrictEqual(await extractor({ download: other }), {});
  }
});

test('set up: a UE4SS installed outside Vortex, with the setting chosen on: replaced, unasked',
  async () => {
    onDisk(flatUe4ss);
    const api = fakeApi(stateWith({
      downloads: pinnedDownload, settings: { autoinstallUe4ss: true, autoinstallUe4ssChosen: true },
    }), { onEmit: installsAs('NewUE4SS') });
    await extension.ensureUe4ss(api, { path: 'C:\\game' });
    assert.deepStrictEqual(api.emitted, ['start-install-download']);
    assert.ok(api.notifications.every((notification) => notification.actions === undefined));
    onDisk();
  });

test('set up: nothing installed once the player turned that off', async () => {
  onDisk();
  const api = fakeApi(stateWith({ downloads: pinnedDownload, settings: { autoinstallUe4ss: false } }),
    { onEmit: installsAs('NewUE4SS') });
  await extension.ensureUe4ss(api, { path: 'C:\\game' });
  assert.deepStrictEqual(api.emitted, []);
});

test('installing UE4SS twice at once installs it once', async () => {
  onDisk();
  const api = fakeApi(stateWith({ downloads: pinnedDownload }), { onEmit: installsAs('NewUE4SS') });
  const [first, second] = await Promise.all([
    extension.installPinnedUe4ss(api), extension.installPinnedUe4ss(api),
  ]);
  assert.strictEqual(first, 'NewUE4SS');
  assert.strictEqual(second, 'NewUE4SS');
  assert.deepStrictEqual(api.emitted, ['start-install-download']);
});

test('a download is taken into Vortex silently, then removed; only while Alchemy Factory is the game '
  + 'being managed', async () => {
  const zip = 'C:\\temp\\UE4SS.zip';
  onDisk({ [zip]: 'the zip' });
  const api = fakeApi(stateWith({ active: 'palworld' }));
  await assert.rejects(extension.importDownload(api, zip), ProcessCanceled);
  assert.deepStrictEqual(api.emitted, []);
  let silent;
  const imports = fakeApi(stateWith(), {
    onEmit: (event, files, callback, quiet) => {
      silent = quiet;
      callback(['imported']);
    },
  });
  assert.strictEqual(await extension.importDownload(imports, zip), 'imported');
  // else Vortex's "File imported" offers to install it again
  assert.strictEqual(silent, true);
  assert.ok(!disk.has(diskKey(zip)));
  onDisk();
});

test('removing UE4SS turns installing it off; Vortex\'s own removals don\'t', async () => {
  const removing = async (modIds, options, mods = { UE4SS: ue4ssMod() }, gameId = 'alchemyfactory') => {
    const api = fakeApi(stateWith({ mods }));
    await extension.onWillRemoveMods(api, gameId, modIds, options);
    return api;
  };
  // what was set aside of a UE4SS installed outside Vortex comes back
  onDisk({ [path.join('C:\\game', win64('UE4SS.dll.vortex_backup'))]: 'another build' });
  const removed = await removing(['UE4SS'], undefined);
  assert.deepStrictEqual(removed.dispatched.map((action) => action.payload), [{ enabled: false }]);
  assert.ok(shown(removed.notifications[0].title) && shown(removed.notifications[0].message));
  assert.ok(onDiskNow(win64('UE4SS.dll')) && !onDiskNow(win64('UE4SS.dll.vortex_backup')));
  onDisk();
  for (const api of [
    await removing(['UE4SS'], { willBeReplaced: true }),
    await removing(['UE4SS'], { reason: 'version_update' }),
    await removing(['UE4SS'], undefined, { UE4SS: ue4ssMod() }, 'palworld'),
    await removing(['FrameRate'], undefined),
    // another UE4SS stays
    await removing(['UE4SS'], undefined, { UE4SS: ue4ssMod(), Other: ue4ssMod('Other') }),
  ]) {
    assert.deepStrictEqual(api.dispatched, []);
    assert.deepStrictEqual(api.notifications, []);
  }
});

test('mods that need UE4SS, with none: a warning whose Fix installs it', async () => {
  onDisk(stagedMods);
  const api = fakeApi(stateWith({
    mods: { FrameRate: luaMod, FastBelts: pakMod, Logic: logicMod, Vault: vaultMod, Movies: moviesMod },
    enabled: ['FrameRate', 'FastBelts', 'Logic', 'Vault', 'Movies'],
    downloads: pinnedDownload,
  }), { onEmit: installsAs('NewUE4SS') });
  const result = await extension.checkUe4ssNeeded(api);
  assert.ok(shown(result.description.short) && shown(result.description.long));
  assert.deepStrictEqual(fixList(result.description.long), ['- install UE4SS 3.0.1-1181-g83330635']);
  assert.strictEqual(result.allowSuppress, false);
  // the UE4SS mod, the Blueprint mod and the game folder's mod with a UE4SS mod in it
  // they're listed in name order
  const places = ['FrameRate', 'Logic', 'Vault'].map((name) => result.description.long.indexOf(name));
  assert.ok(places.every((place, index) => place !== -1 && (index === 0 || place > places[index - 1])));
  assert.strictEqual(await result.automaticFix(), 'NewUE4SS');
  assert.deepStrictEqual(api.emitted, ['start-install-download']);
  onDisk();
});

test('mods that need UE4SS, with it disabled: a warning whose Fix enables it', async () => {
  onDisk(stagedMods);
  const api = fakeApi(stateWith({ mods: { FrameRate: luaMod, UE4SS: ue4ssMod() }, enabled: ['FrameRate'] }));
  const result = await extension.checkUe4ssNeeded(api);
  assert.ok(shown(result.description.short) && shown(result.description.long));
  assert.deepStrictEqual(fixList(result.description.long), ['- enable UE4SS']);
  await result.automaticFix();
  assert.deepStrictEqual(api.enabled, [{ modIds: ['UE4SS'], enabled: true }]);
  onDisk();
});

test('no warning when the game has UE4SS, no mod needs it, or another game is managed', async () => {
  for (const [state, files] of [
    [stateWith({ mods: { FrameRate: luaMod, UE4SS: ue4ssMod() }, enabled: ['FrameRate', 'UE4SS'] }), {}],
    [stateWith({ mods: { FrameRate: luaMod }, enabled: ['FrameRate'] }), outsideUe4ss],
    [stateWith({ mods: { FastBelts: pakMod }, enabled: ['FastBelts'] }), {}],
    [stateWith({ mods: { Movies: moviesMod }, enabled: ['Movies'] }), {}],
    // installed, but not enabled
    [stateWith({ mods: { FrameRate: luaMod } }), {}],
    [stateWith({ mods: { FrameRate: luaMod }, enabled: ['FrameRate'], active: 'palworld' }), {}],
  ]) {
    onDisk({ ...stagedMods, ...files });
    assert.strictEqual(await extension.checkUe4ssNeeded(fakeApi(state)), undefined);
  }
  onDisk();
});

test('UE4SS that isn\'t the pinned build: a warning whose Fix switches to the pinned one', async () => {
  const other = installed('Other', UE4SS_TYPE, { fileName: 'UE4SS_v3.0.1-1164-g5e627997.zip' });
  const mods = { Other: other, Pinned: ue4ssMod('Pinned') };
  onDisk({ ...stagedUe4ss('Other', 'another build'), ...stagedUe4ss('Pinned', 'the pinned build') });
  const api = fakeApi(stateWith({ mods, enabled: ['Other'] }));
  const result = await extension.checkUe4ssBuild(api);
  assert.ok(shown(result.description.short));
  // both versions named, and the pinned one enabled rather than installed
  assert.ok(result.description.long.startsWith('Mods require UE4SS 3.0.1-1181-g83330635 or newer but UE4SS '
    + '3.0.1-1164-g5e627997 is installed.'), result.description.long);
  assert.deepStrictEqual(fixList(result.description.long),
    ['- enable UE4SS 3.0.1-1181-g83330635', '- disable UE4SS 3.0.1-1164-g5e627997']);
  // no pinned build in Vortex, and no version in the mod's names: installed, the mod named instead
  onDisk({ ...stagedUe4ss('Custom', 'another build') });
  const custom = await extension.checkUe4ssBuild(fakeApi(stateWith({ mods: { Custom: ue4ssMod('Custom') },
    enabled: ['Custom'] })));
  assert.ok(custom.description.long.includes('but "Custom" is installed'));
  assert.deepStrictEqual(fixList(custom.description.long),
    ['- install UE4SS 3.0.1-1181-g83330635', '- disable Custom']);
  onDisk({ ...stagedUe4ss('Other', 'another build'), ...stagedUe4ss('Pinned', 'the pinned build') });
  await result.automaticFix();
  assert.deepStrictEqual(api.enabled,
    [{ modIds: ['Other'], enabled: false }, { modIds: ['Pinned'], enabled: true }]);
  // the pinned build enabled: no warning
  assert.strictEqual(await extension.checkUe4ssBuild(fakeApi(stateWith({ mods, enabled: ['Pinned'] }))),
    undefined);
  onDisk();
});

test('UE4SS newer than the pinned build: no warning, unless an enabled C++ mod needs newer still',
  async () => {
    const build = (id, version) => installed(id, UE4SS_TYPE, { fileName: `UE4SS_v${version}.zip` });
    const cpp = installed('Cpp', '',
      { alchemyFactoryMetadata: { name: 'Cpp', version: '1.0.0', ue4ss: '3.0.1-1200' } });
    const mods = { Newer: build('Newer', '3.0.1-1190-g1234abcd'), Pinned: ue4ssMod('Pinned'), Cpp: cpp };
    onDisk({ ...stagedUe4ss('Newer', 'a newer build'), ...stagedUe4ss('Pinned', 'the pinned build') });
    assert.strictEqual(await extension.checkUe4ssBuild(fakeApi(stateWith({ mods, enabled: ['Newer'] }))),
      undefined);
    // the Install UE4SS button leaves it alone too
    const button = fakeApi(stateWith({ mods, enabled: ['Newer'] }));
    await extension.installUe4ssAction(button);
    assert.deepStrictEqual([button.emitted, button.enabled], [[], []]);
    // a C++ mod built against a newer build still, and no such build in Vortex: no Fix
    const needing = await extension.checkUe4ssBuild(fakeApi(stateWith({ mods, enabled: ['Newer', 'Cpp'] })));
    const { long } = needing.description;
    assert.ok(long.startsWith('Mods require UE4SS 3.0.1-1200 or newer but UE4SS 3.0.1-1190-g1234abcd is '
      + 'installed.[br][/br][br][/br]Mods which require UE4SS 3.0.1-1200:'), long);
    assert.ok(long.includes('- Cpp 1.0.0[br][/br]') && long.endsWith('Install UE4SS 3.0.1-1200 or newer.'), long);
    assert.strictEqual(needing.automaticFix, undefined);
    // with one in Vortex: Fix enables it
    const newest = { ...mods, Newest: build('Newest', '3.0.1-1205-g5678abcd') };
    onDisk({ ...stagedUe4ss('Newer', 'a newer build'), ...stagedUe4ss('Newest', 'the newest build') });
    const api = fakeApi(stateWith({ mods: newest, enabled: ['Newer', 'Cpp'] }));
    const fixable = await extension.checkUe4ssBuild(api);
    assert.deepStrictEqual(fixList(fixable.description.long),
      ['- enable UE4SS 3.0.1-1205-g5678abcd', '- disable UE4SS 3.0.1-1190-g1234abcd']);
    await fixable.automaticFix();
    assert.deepStrictEqual(api.enabled,
      [{ modIds: ['Newer'], enabled: false }, { modIds: ['Newest'], enabled: true }]);
    onDisk();
  });

// mods with manifest.json metadata: the vault requires the library at 0.2.5 or newer
const withMetadata = (id, metadata) => installed(id, '', { alchemyFactoryMetadata: metadata });
const vaultNeedingLibrary = withMetadata('Vault', {
  name: 'AlchemistsVault', version: '0.8.4', requirements: [{ name: 'AlchemistsLibrary', version: '0.2.5' }],
});
const library = (version) => withMetadata('Library', { name: 'AlchemistsLibrary', version });
const requirementsCheck = (mods, enabled, active) =>
  extension.checkRequirements(fakeApi(stateWith({ mods, enabled, active })));

test('requirements: a warning when a required mod is missing, disabled or too old', async () => {
  for (const [mods, enabled, fixable] of [
    [{ Vault: vaultNeedingLibrary }, ['Vault'], false],
    [{ Vault: vaultNeedingLibrary, Library: library('0.2.5') }, ['Vault'], true],
    [{ Vault: vaultNeedingLibrary, Library: library('0.2.4') }, ['Vault', 'Library'], false],
    // disabled, but too old
    [{ Vault: vaultNeedingLibrary, Library: library('0.2.4') }, ['Vault'], false],
    // an enabled copy too old, and a newer one disabled
    [{ Vault: vaultNeedingLibrary, Library: library('0.2.4'), New: { ...library('0.2.5'), id: 'New' } },
      ['Vault', 'Library'], true],
  ]) {
    const result = await requirementsCheck(mods, enabled);
    assert.strictEqual(result.severity, 'warning');
    assert.ok(shown(result.description.short) && shown(result.description.long));
    // it names the mod and what it needs
    const { long } = result.description;
    assert.ok(long.includes('Vault') && long.includes('AlchemistsLibrary'));
    assert.strictEqual(typeof result.automaticFix === 'function', fixable);
    assert.strictEqual(long.includes('Click Fix'), fixable);
  }
});

test('requirements: Fix enables the disabled mods required, and what they require, matched by '
  + 'manifest.json name, not the name shown', async () => {
  // a library the library needs, and two copies of the library, renamed
  const core = withMetadata('Core', { name: 'AlchemistsCore', version: '1.0.0' });
  const libraryNeedingCore = (id, version) => ({
    ...withMetadata(id, {
      name: 'AlchemistsLibrary', version, requirements: [{ name: 'AlchemistsCore', version: '1.0.0' }],
    }),
  });
  const renamed = (mod, customFileName) => ({ ...mod, attributes: { ...mod.attributes, customFileName } });
  const mods = {
    Vault: vaultNeedingLibrary,
    Old: renamed(libraryNeedingCore('Old', '0.2.6'), 'My library'),
    New: renamed(libraryNeedingCore('New', '0.3.0'), 'Another name'),
    Core: core,
  };
  // what Fix changes: always a list, one change a line
  const changes = (result) => fixList(result.description.long);
  const api = fakeApi(stateWith({ mods, enabled: ['Vault'] }));
  const result = await extension.checkRequirements(api);
  // each mod named with its version, as two copies of a mod share a name
  assert.ok(result.description.long.startsWith('Vault 0.8.4 missing dependencies:'), result.description.long);
  assert.deepStrictEqual(changes(result), ['- enable Another name 0.3.0', '- enable Core 1.0.0']);
  await result.automaticFix();
  assert.deepStrictEqual(api.enabled, [{ modIds: ['New', 'Core'], enabled: true }]);
  // an enabled copy too old: the newest copy enabled instead, and the old one disabled first
  const copy = (id, version) => renamed({ ...library(version), id }, 'AlchemistsLibrary');
  const tooOldApi = fakeApi(stateWith({
    mods: { Vault: vaultNeedingLibrary, Old: copy('Old', '0.2.4'), New: copy('New', '0.2.5'),
      Newest: copy('Newest', '0.3.0') },
    enabled: ['Vault', 'Old'],
  }));
  const tooOld = await extension.checkRequirements(tooOldApi);
  assert.deepStrictEqual(changes(tooOld),
    ['- enable AlchemistsLibrary 0.3.0', '- disable AlchemistsLibrary 0.2.4']);
  await tooOld.automaticFix();
  assert.deepStrictEqual(tooOldApi.enabled,
    [{ modIds: ['Old'], enabled: false }, { modIds: ['Newest'], enabled: true }]);
  // more changes: enables first, then disables
  const several = await extension.checkRequirements(fakeApi(stateWith({
    mods: { ...mods, Older: renamed(libraryNeedingCore('Older', '0.2.0'), 'My library') },
    enabled: ['Vault', 'Older'],
  })));
  assert.deepStrictEqual(changes(several),
    ['- enable Another name 0.3.0', '- enable Core 1.0.0', '- disable My library 0.2.0']);
});

test('requirements: no warning when the required mod is enabled and new enough, the mod needing it '
  + 'is disabled, or another game is managed', async () => {
  for (const [mods, enabled, active] of [
    [{ Vault: vaultNeedingLibrary, Library: library('0.2.5') }, ['Vault', 'Library']],
    // dotted numbers compare as numbers, not text
    [{ Vault: vaultNeedingLibrary, Library: library('0.10.0') }, ['Vault', 'Library']],
    // a version that isn't dotted numbers can't be compared, so it counts as new enough
    [{ Vault: vaultNeedingLibrary, Library: library('beta') }, ['Vault', 'Library']],
    [{ Vault: vaultNeedingLibrary }, []],
    [{ Vault: vaultNeedingLibrary }, ['Vault'], 'palworld'],
  ]) {
    assert.strictEqual(await requirementsCheck(mods, enabled, active), undefined);
  }
});

test('Install UE4SS: the pinned build, replacing one outside Vortex, unless Vortex has it; the '
  + 'setting on', async () => {
  onDisk({ ...stagedUe4ss('UE4SS', 'the pinned build') });
  const installed = fakeApi(stateWith({ mods: { UE4SS: ue4ssMod() }, enabled: ['UE4SS'] }));
  await extension.installUe4ssAction(installed);
  assert.strictEqual(installed.notifications.length, 1);
  assert.ok(shown(installed.notifications[0].message));
  assert.deepStrictEqual(installed.dispatched.map((action) => action.payload), [{ enabled: true }]);
  const disabled = fakeApi(stateWith({ mods: { UE4SS: ue4ssMod() } }));
  await extension.installUe4ssAction(disabled);
  assert.deepStrictEqual(disabled.enabled, [{ modIds: ['UE4SS'], enabled: true }]);
  // the player turned Autoinstall UE4SS off, and has a UE4SS of their own: replaced all the same
  onDisk(flatUe4ss);
  const outside = fakeApi(stateWith({
    downloads: pinnedDownload, settings: { autoinstallUe4ss: false, autoinstallUe4ssChosen: true },
  }), { onEmit: installsAs('NewUE4SS') });
  await extension.installUe4ssAction(outside);
  assert.deepStrictEqual(outside.dispatched[0].payload, { enabled: true });
  assert.deepStrictEqual(outside.emitted, ['start-install-download']);
  assert.deepStrictEqual(outside.enabled, [{ modIds: ['NewUE4SS'], enabled: true }]);
  onDisk();
  const none = fakeApi(stateWith({ downloads: pinnedDownload }), { onEmit: installsAs('NewUE4SS') });
  await extension.installUe4ssAction(none);
  assert.deepStrictEqual(none.emitted, ['start-install-download']);
});

test('UE4SS.dll\'s checksum is read again only once the file changes', async () => {
  onDisk(stagedUe4ss('Cached', 'the pinned build'));
  const dll = diskKey('C:\\staging\\Cached\\ue4ss\\UE4SS.dll');
  const readsOfDll = () => reads.filter((file) => file === dll).length;
  const before = readsOfDll();
  const api = fakeApi(stateWith({ mods: { Cached: ue4ssMod('Cached') }, enabled: ['Cached'] }));
  assert.strictEqual(await extension.checkUe4ssBuild(api), undefined);
  assert.strictEqual(await extension.checkUe4ssBuild(api), undefined);
  assert.strictEqual(readsOfDll() - before, 1);
  // another build installed in its place
  onDisk(stagedUe4ss('Cached', 'another build'));
  assert.notStrictEqual(await extension.checkUe4ssBuild(api), undefined);
  assert.strictEqual(readsOfDll() - before, 2);
  onDisk();
});

test('another game managed: the notifications about UE4SS go', () => {
  const switched = fakeApi(stateWith({ active: 'palworld' }));
  extension.onGameModeActivated(switched);
  assert.deepStrictEqual(switched.dismissed.sort(), ['alchemyfactory-ue4ss-left-alone',
    'alchemyfactory-ue4ss-manage', 'alchemyfactory-ue4ss-outside',
    'alchemyfactory-ue4ss-outside-other-build', 'alchemyfactory-ue4ss-removed']);
  const managed = fakeApi(stateWith());
  extension.onGameModeActivated(managed);
  assert.deepStrictEqual(managed.dismissed, []);
});

test('the game\'s version: its Steam build', async () => {
  onDisk({
    'C:\\steam\\steamapps\\appmanifest_3669570.acf':
      '"AppState"\n{\n\t"appid"\t\t"3669570"\n\t"buildid"\t\t"25991404"\n}\n',
  });
  assert.strictEqual(await extension.gameVersion('C:\\steam\\steamapps\\common\\Alchemy Factory'),
    '25991404');
  // not in a Steam library: Vortex reads the executable's instead
  await assert.rejects(extension.gameVersion('C:\\games\\Alchemy Factory'));
  onDisk();
});
