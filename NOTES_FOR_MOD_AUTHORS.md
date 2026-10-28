# Notes for Mod Authors

What to know before publishing an Alchemy Factory mod on Nexus Mods: how Vortex installs each kind of mod, the
layout to use, and the one problem every mod that changes the game's tables runs into. Once a mod is on Nexus Mods,
players install it through **Mod manager download** whatever its page says, so an archive Vortex places right
matters more than install instructions.

Paths below are inside `AlchemyFactory/` in the game folder (the Steam folder holding `AlchemyFactory.exe`), and
`ue4ss` is `AlchemyFactory/Binaries/Win64/ue4ss`.

## Kinds of mod

| Kind | Made of | Loads from | Needs UE4SS |
|---|---|---|---|
| Pak | Cooked content as `.pak` + `.utoc` + `.ucas`, named `..._P` ([tables](#two-mods-changing-the-same-table)) | `Content/Paks/~mods/` | No |
| Lua | A UE4SS mod: `Scripts/main.lua` | `ue4ss/Mods/<Name>/` | Yes |
| C++ | A UE4SS mod: `dlls/main.dll`, built against one UE4SS build ([UE4SS](#ue4ss)) | `ue4ss/Mods/<Name>/` | Yes |
| Blueprint | A pak of Blueprints that UE4SS's BPModLoaderMod spawns | `Content/Paks/LogicMods/` | Yes |

Which to pick:

- **Numbers and rows in the game's tables** (recipes, costs, research, quests, prices): edit them at run time
  through the shared library once it's out, rather than shipping a pak with the whole table
  ([tables](#two-mods-changing-the-same-table)).
- **Behaviour**: Lua. C++ only for what Lua can't do, as it ties the mod to one UE4SS build.
- **New content** (models, textures, Blueprints): a pak, under an asset path of your own (`/Game/Mods/<YourMod>/`)
  so no two mods share a path.

UE4SS isn't a hurdle for players: Vortex installs it for everyone ([UE4SS](#ue4ss)).

## How Vortex installs an archive

Vortex goes by the archive's files, not its name or page, and the first matching row decides.

| The archive holds | Installed to |
|---|---|
| UE4SS (`UE4SS.dll`) | Nothing: Vortex installs UE4SS itself ([UE4SS](#ue4ss)) |
| The game folder's layout (`AlchemyFactory/Content/...`, `AlchemyFactory/Binaries/...`) | As laid out ([the layout to use](#the-layout-to-use-the-game-folders)) |
| A UE4SS mod: a folder with `Scripts/main.lua` or `dlls/main.dll` | `ue4ss/Mods/<folder>/` ([other layouts](#other-layouts-vortex-recognises)) |
| Shared Lua modules: `shared/<name>/...` | `ue4ss/Mods/shared/<name>/` |
| Paks (`.pak`, `.utoc`, `.ucas`, `.sig`) | `Content/Paks/~mods/` |
| Paks in a `LogicMods` folder | `Content/Paks/LogicMods/` |

Case doesn't matter, nor do folders above the ones named. An archive with `fomod/ModuleConfig.xml` goes to Vortex's
FOMOD installer, with paths relative to the game folder.

## The layout to use: the game folder's

```text
MyMod.zip
├── manifest.json                       (optional: name, version, requirements)
└── AlchemyFactory/
    ├── Binaries/Win64/ue4ss/Mods/MyMod/
    │   ├── Scripts/main.lua
    │   └── enabled.txt
    └── Content/Paks/~mods/MyMod_P.pak, MyMod_P.utoc, MyMod_P.ucas
```

- Everything below `AlchemyFactory/` is installed as it is, so one archive carries Lua, C++ and paks together, and a
  player without Vortex extracts it into the game folder and gets the same result.
- Include an empty `enabled.txt` with each UE4SS mod. Vortex adds one if it's missing, but a hand install needs it,
  and a collection can only replicate an archive whose files are all its own.
- Nothing beside `AlchemyFactory/` is installed. A README, an icon or a `manifest.json` there is fine (the manifest
  is read: [the name and version](#the-name-and-version-vortex-shows)); tools or presets there reach no one.
- UE4SS's own files (`UE4SS.dll`, its loader, settings, signatures, `Mappings.usmap`, `mods.txt`, its built-in mods,
  `UEHelpers`) are left out: Vortex's UE4SS has them ([UE4SS](#ue4ss)).

## Other layouts Vortex recognises

Mods on Nexus Mods already use these, so Vortex takes them as they are. A new mod is better off with the game
folder's layout.

**Paks alone**, loose or in any folders (`Content/Paks/` included): to `~mods`, flat.

```text
MyMod.zip
└── MyMod_P.pak, MyMod_P.utoc, MyMod_P.ucas
```

**A UE4SS mod's folder** (one with `Scripts/main.lua` or `dlls/main.dll`), wherever it is in the archive: to
`ue4ss/Mods/<folder>/` with everything in it (settings, data), plus an `enabled.txt` if missing. Files beside the
folder aren't installed. Paks anywhere in the archive go to `~mods`, and a `shared/<name>/` beside the folder goes to
`ue4ss/Mods/shared/<name>/`. Without a folder (`Scripts/main.lua` at the top of the archive) Vortex names the mod
after the archive (`My Mod-123-1-0.zip` gives `MyMod`), so give it one.

```text
MyMod.zip
└── MyMod/
    ├── Scripts/main.lua
    ├── dlls/main.dll
    └── enabled.txt
```

**Shared Lua modules alone** (`shared/<name>/...`): a library, to `ue4ss/Mods/shared/<name>/`, with no `enabled.txt`.

**Blueprint mods**: paks in a `LogicMods` folder go to `Content/Paks/LogicMods/`, keeping what's below it. Outside
one, the pak lands in `~mods`, where BPModLoaderMod doesn't look.

```text
MyBlueprintMod.zip
└── LogicMods/MyBlueprintMod.pak
```

## Two mods changing the same table

The game reads each DataTable whole from one container. A pak holding an edited recipes table replaces the whole
table, so two paks that edit the same table don't combine: one wins, and every change in the other is silently
gone, even changes to different rows. Vortex doesn't merge them, and has no load order for this game. Two paks with
the same file name are a conflict Vortex asks the player to settle; with different names both are deployed, and the
game decides:

- A pak only overrides the game's files when its name ends in `_P` (Unreal's patch suffix). Always use it.
- Among `_P` paks, the first in alphabetical order wins, by path (checked in game: `~mods/0001-A/` beat
  `~mods/0002-B/` with the same table in both, either way round; file names sort the same way). That's the opposite
  of the `zzz_` convention from other Unreal games.
- A number before `_P` outranks the alphabet: `MyMod_1_P` beats every plain `_P` pak, `MyMod_2_P` beats `_1_P`, and
  so on (Unreal's patch numbering; not yet checked in this game).

Two ways out, in order of preference:

1. **Edit the table at run time** instead of replacing it. A shared library is being written for this and will be
   published on Nexus Mods. A Lua mod hands it the rows and fields to change, or rows to add (a recipe, a research
   node, a building copied from one of the game's), and the library applies them as the tables load, on every
   machine. Edits from several mods to one table combine field by field, and two mods setting the same field is
   logged rather than lost. The mod needs UE4SS, which Vortex installs anyway, and lists the library as a
   requirement ([requirements](#requirements)). Choose this for every change that is a number, a name, a list or a
   new row.
2. **Name the pak for priority** when the change has to be a pak: cooked assets (models, textures, Blueprints), or a
   table edit the library can't make yet. Replace only the tables you must, put new assets under a path of your own
   (`/Game/Mods/<YourMod>/`) so they can't clash, and say on your page which tables the pak replaces, so players
   know what it can't be combined with. For a patch that must beat another mod's pak, use a number: `MyPatch_1_P`.

## UE4SS mods (Lua and C++)

- Everything in the mod's folder is installed (settings, data). `enabled.txt` enables it; don't rely on `mods.txt`,
  which Vortex's UE4SS replaces (one in an archive is dropped).
- **Settings players edit**: have the mod write the file at first run rather than shipping it. Vortex hard-links
  what it installs, so a player's edits to a shipped file change Vortex's copy, and an update replaces it (Vortex
  asks first). A file the mod creates isn't Vortex's, and survives updates and purges.
- **C++ mods** are built against one UE4SS build: the one Vortex installs, or newer ([UE4SS](#ue4ss)). Name the
  build in `manifest.json` as `ue4ss_version` (`"3.0.1-1181-g83330635"`, or `"3.0.1-1181"`), and Vortex warns
  players whose UE4SS is older.
- Paks beside a UE4SS mod go to `~mods` wherever they are in the archive, so a Lua mod with its own assets ships as
  one archive.
- Blueprint mods need BPModLoaderMod, which is on in Vortex's UE4SS by default.

## UE4SS

- Vortex installs UE4SS `v3.0.1-1181-g83330635` (from UE4SS's experimental builds) for every player, before any mod.
  Your page can say "Vortex installs UE4SS" in place of install steps.
- Build C++ mods against that build, or a newer one: UE4SS's C++ interface is stable from 1181. Lua mods mostly don't
  mind the build.
- Don't bundle UE4SS, nor its settings, signatures, built-in mods or `UEHelpers`. If you do, Vortex installs the mod
  without them and tells the player. An archive of only those is refused.

## Versions and options

- Ship each version of a mod (X2, X5; a translation with and without its font) as a separate file on your page.
  Vortex installs each as its own mod, and two at once is a conflict it asks about.
- One archive with a folder per version is recognised (Vortex asks "Choose what to install"), but a collection
  installs the first folder unless its curator sets **Replicate installer choices**.
- Presets a player copies and renames by hand inside the mod's folder edit Vortex's own copy, which Vortex notices
  on the next deploy. Make them separate files, or settings the mod reads.

## Requirements

Two places, both worth filling in:

- Your page's **Requirements** on Nexus Mods: Vortex's own health check flags a missing one.
- `manifest.json`'s `dependencies`, each `<team>-<name>-<version>`: Vortex warns a player whose copy of the required
  mod is missing, disabled or older, and its **Fix** enables one that's installed but disabled. Mods are matched by
  their own `manifest.json`'s `name`, so a mod you require must ship one. Leave UE4SS out: Vortex handles it itself.

## What Vortex doesn't install

- **Save games** (`.sav`) and **Cheat Engine tables** (`.CT`) are refused, telling the player where they go
  (`%LOCALAPPDATA%\AlchemyFactory\Saved\SaveGames`; Cheat Engine). Say on their page how to install them by hand.
- **Patches to the game's executable**: Vortex can't run or undo them, and every game update reverts them. A UE4SS
  mod does the same job and survives updates. Until then, say "manual install" on the page.
- **Anything else** is copied into the game folder as the archive lays it out (Vortex's fallback). That's how a mod
  for AF Mod Loader installs: put `mods/` at the top of the archive (`mods/my-mod/mod.json`), and it lands in the
  game folder's `mods/`.

## The name and version Vortex shows

Mods from Nexus Mods show their page's. For an archive from anywhere else, a `manifest.json` at the archive's top
in Thunderstore's format fills them in:

```json
{
  "name": "My_Mod",
  "version_number": "1.2.0",
  "description": "What it does.",
  "website_url": "https://www.nexusmods.com/alchemyfactory/mods/123",
  "dependencies": ["SomeTeam-SomeLibrary-1.0.0"],
  "ue4ss_version": "3.0.1-1181"
}
```

`name` is the name (underscores as spaces), `version_number` the version (without it the file isn't read),
`description` the description and `website_url` the source. `dependencies` and `ue4ss_version` (this extension's own
field) are read for every mod, Nexus Mods' included ([requirements](#requirements), [UE4SS](#ue4ss)).
