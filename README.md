# Alchemy Factory for Vortex

A [Vortex](https://www.nexusmods.com/about/vortex/) extension for Alchemy Factory. It:

- finds the game in Steam libraries, launches it through Steam, and shows its Steam build as the version (the
  executables carry the engine's);
- deploys with hardlinks only, so the staging folder must be on the game's drive: symlinked `.utoc`/`.ucas` crash
  UE5 games (Nexus Mods reproduced it on another UE5 game);
- installs UE4SS when the game is first managed: the build the game's C++ mods are built against, from UE4SS's
  experimental release (which keeps every build), checked against its SHA-256 ([UE4SS](#ue4ss));
- installs each kind of mod where it loads ([NOTES_FOR_MOD_AUTHORS.md](NOTES_FOR_MOD_AUTHORS.md) has the layouts).

## Installers

In the order Vortex tries them:

| Installer | Takes | Places |
|---|---|---|
| UE4SS | `UE4SS.dll` | `dwmapi.dll` beside the executable, the rest in `Binaries/Win64/ue4ss/`. A mod bundled with UE4SS installs as the mod alone; the player is told |
| Game layout | `AlchemyFactory/Content/...` or `AlchemyFactory/Binaries/...`, unless only containers in `Content/Paks` | As laid out |
| UE4SS mod | A folder with `Scripts/main.lua` or `dlls/main.dll`; `shared/<name>/` Lua modules | `ue4ss/Mods/<folder>/`, with an `enabled.txt`; `ue4ss/Mods/shared/<name>/` |
| Containers | `.pak`, `.utoc`, `.ucas`, `.sig` | `Content/Paks/~mods/`, or `Content/Paks/LogicMods/` from a `LogicMods` folder |
| Unplaceable | Only `.sav` or `.CT` files (and documents) | Refused, with where they go; Vortex's fallback would copy them into the game folder |

An archive with `fomod/ModuleConfig.xml` is left to Vortex's FOMOD installer. Vortex 2.9 has two, at priorities 10
and 20, among the extension's (10 to 50), so each installer declines FOMODs itself. The game layout and UE4SS mod
installers leave UE4SS's own files out ([UE4SS](#ue4ss)).

Containers in several folders outside `LogicMods` are usually versions (`X2/`, `X5/`), so the player picks: one if
the folders share a file name, else any (all ticked). The choice is saved as `installerChoices`, and **Reinstall** and
updates use it unasked: Vortex passes it back only for archives from Nexus Mods, so the extension keeps it itself
when Vortex removes a mod to replace it. Collections install unattended and pass it back only for a mod set to
**Replicate installer choices** (Vortex then warns "No Installer Options saved", a FOMOD check; the choice works);
otherwise the first folder, or all.

## Mod types

UE4SS has a mod type of its own, deployed into `Binaries/Win64`, so the extension can find it. Every other mod is of
Vortex's default type, the game folder, whichever installer placed it (Vortex's own, for FOMODs and its fallback,
included): staged as laid out from the game folder, and shown with a blank Mod Type in the mods list. Both types'
folders exist in every install: Vortex offers hardlinks only while every type's folder does.

Vortex deploys each type in a pass of its own, with its own manifest, so two types deploying the same file raise its
External Changes dialog on every deploy (its cross-type conflict detection needs a rule from the player first, and
purges every mod to apply one). One type for mods makes two mods with the same file an ordinary conflict, and the
installers keep UE4SS's own files out of mods ([UE4SS](#ue4ss)).

A pak load order would bring back a Paks type, deployed into `Content/Paks/~mods` with a numbered folder per mod
(`mergeMods`). A type is safe beside the default one only while nothing else can deploy into its folder, which a
folder per mod guarantees.

`enabled.txt` never counts as a conflict (a mod and its patch both have one). Replicate can't be used for a UE4SS mod
whose `enabled.txt` the extension made, as it wants every file in the archive; the default, a fresh install, makes it
again.

Vortex doesn't merge table changes: two container mods changing the same table replace each other.

## What the mods list shows

Mods not from Nexus Mods (dropped on the mods page, say) have no metadata, so the extension fills the empty columns:

| Column | From |
|---|---|
| Mod Name, Version, description | A Thunderstore `manifest.json` (one with `version_number`): `name` (underscores as spaces), `version_number`, `description` |
| Source | `website_url`, else "Other" (Vortex warns beside mods without a source) |
| Category | "Miscellaneous", Nexus Mods' only category for the game |

On install the manifest replaces what Vortex made up (a name from the archive's, say); later only empty columns are
filled. A name the player gives is kept through reinstalls and updates: the extension records the name it gave
(`alchemyFactoryName`), which Vortex carries over. Nothing is guessed from the archive's name. Thunderstore manifests
have no author. Mods from Nexus Mods keep its data, which also drives their update checks: installers keep manifest
values in an attribute of their own.

## UE4SS

- **Managed by Vortex** while **Game settings → Mods → Autoinstall UE4SS** is on (the default), as in Palworld's
  extension: installed on first managing the game, whenever Vortex has none, and at once when the player turns the
  setting on, so no restart is needed. A disabled UE4SS stays disabled.
- **Installed some other way** (its `UE4SS.dll` in `ue4ss/` or beside the executable): while the setting is on only
  by default, the player is asked "Let Vortex manage it?" (or "Replace it with the version mods need?"). **Manage**
  replaces it; **Leave it** turns the setting off; dismissed, it's asked again next time the game is managed. Once the
  player has chosen the setting (answering, in Settings, removing UE4SS, or **Install UE4SS**), it's replaced unasked
  while on and left alone while off, with a notification that can be hidden for good (a warning if it isn't the
  pinned build). Vortex lists only what it installed, so one left alone isn't in the mods list.
- **Replacing** one: Vortex deploys over its files, keeping each as `<file>.vortex_backup` and restoring them when
  its UE4SS is disabled, removed or purged. Files the pinned build doesn't replace but which would load the old one
  (`UE4SS.dll` beside the executable, `xinput1_3.dll`; never a file Vortex deployed) are set aside the same way after
  each deploy with Vortex's UE4SS, and put back after one without, or when the player removes UE4SS. A purge puts
  them back; the next deploy sets them aside again. `Mods/mods.txt` is replaced too, so a mod enabled only there
  needs an `enabled.txt`.
- **Its name** is "UE4SS" with the pinned version, installed or only downloaded, rather than the zip's name or what
  Nexus Mods has of the same zip (Vortex looks archives up by MD5; since 2.9, only on the game's pages and Modding
  Tools). An attribute extractor at priority 20 gives it (the lowest wins); a name the player gives still wins.
- **Removing it** (every copy) turns Autoinstall UE4SS off, with a notification. Vortex's own removals (updates,
  replacements) don't. Only the player turns it back on: in Settings or with **Install UE4SS**; **Fix** doesn't.
- **A mod that needs it** (files in `ue4ss/Mods/` or `Content/Paks/LogicMods/`, which the installers record; mods
  Vortex's own installers placed are checked on disk) enabled with no UE4SS, or a disabled one, raises "Some mods
  need UE4SS" (or "..., which is disabled") until fixed. **More** lists the mods; **Fix** installs or enables it.
- **An older build** enabled raises "UE4SS isn't the version mods need", naming both versions (or the mod's name, if
  none of its names has a version). Older means older than the pinned build, or than the newest an enabled mod's
  `manifest.json` asks for in `ue4ss_version` (the build a C++ mod was built against; those mods are listed). A newer
  build gets no warning, as UE4SS's C++ interface is stable from 1181. Builds compare by release, then by the count of
  commits since it (the 1181 in `3.0.1-1181-g83330635`). One whose build can't be told and isn't the pinned build
  counts as older. **Fix** switches to a UE4SS in Vortex that is new enough, the pinned build first, else installs the
  pinned build if that is new enough. The other stays installed, disabled. With neither, there's no **Fix**. Can be
  hidden for good. **Install UE4SS** leaves a newer build alone too.
- **A mod bundled with UE4SS**, or with UE4SS's own files (its loader, settings, built-in mods or libraries), installs
  without them: "Left out the UE4SS files bundled with ...". Its mod list (`mods.txt`, `mods.json`) is left out
  without a word. An archive of only those files is refused, saying Vortex installs UE4SS itself.
- **Install UE4SS** on the mods toolbar (pinned by default) turns the setting on and installs or enables the pinned
  build, replacing one installed some other way.

Two installs at once are one install. A download finishing after a switch to another game isn't taken in (Vortex
would file it under that game); it's installed when Alchemy Factory is managed again. Switching game dismisses the
UE4SS notifications, as in Palworld's extension; setting the game up resends those still true.

The warnings are `registerTest` checks, run when the game is managed, when its profile changes, and as mods are
installed or enabled. Vortex 2.9's `registerHealthCheck` shows nothing for an extension's checks.

## Requirements

A mod's `manifest.json` can list the mods it needs in `dependencies`, each `<team>-<name>-<version>` (for example
`AlchemistsTools-AlchemistsLibrary-0.2.5`). The installers record them, and an enabled mod whose requirement isn't
installed, is disabled, or is older than that version raises "Some mods are missing requirements". **More** lists
each mod and what it needs. Mods are matched by their `manifest.json` `name`, never the name the mods list shows, so
renaming a mod changes nothing, and mods from Nexus Mods and from files count the same. UE4SS is left out (its own
checks cover it). **Fix** enables required mods that are installed but disabled: the newest copy new enough, then
what that requires in turn. An older copy enabled instead is disabled, as the two would conflict. Fix can't install a
missing mod, as Vortex can't download a mod by that name. **More** names each mod with its version, as copies share a
name, and lists what Fix changes, one a line, enables first. Mods installed before this was added need reinstalling
for their requirements to be read.

Vortex's own "requires" rules aren't used. Vortex tries to install a required mod as soon as the mod requiring it is
enabled, and disables any rule it can't fulfil (any without a Nexus Mods download behind it) with an "Unfulfillable
rule dropped" warning. Nexus Mods' own **Requirements** on a mod's page still work as usual: Vortex 2.9's Mod
Requirements health check flags those.

## Files

`info.json` (`id` names the folder in Vortex's plugins, so a newer copy replaces an older one), `index.js` (Vortex
provides `vortex-api`, `redux-act`, React, `react-bootstrap` and `react-redux`), `gameart.jpg` (640x360, the Steam
library art), `index.test.js`, `NOTES_FOR_MOD_AUTHORS.md` (for the Nexus Mods page; not in the zip),
`.github/workflows/test.yml` (the tests, see Testing), `.gitignore` (the release zip) and `LICENSE`. The UE4SS pin is
`index.js`'s `UE4SS`: version, the zip's name and URL, its SHA-256 and `UE4SS.dll`'s.

## Testing

`node --test`: the installers with archives' file lists, the rest with a stand-in Vortex. GitHub runs it on Windows
with Node.js 24 on every push and pull request.

In Vortex: package it (below), Extensions → **Drop File(s)**, restart. Manage Alchemy Factory and check UE4SS is
deployed; install a mod of each kind and check where its files go. A development copy can go straight in
`%APPDATA%\Vortex\plugins\game-alchemyfactory\`.

## Releasing

Raise `version` in `info.json`, then, in MSYS (it has no `zip`, so Windows' own `tar.exe` writes the zip):

```sh
rm -f game-alchemyfactory-<version>.zip
/c/Windows/System32/tar.exe -a -cf game-alchemyfactory-<version>.zip info.json index.js gameart.jpg
unzip -l game-alchemyfactory-<version>.zip
```

Upload to Nexus Mods under the game, **Modding Tools** → **Vortex Extensions**, as the one main file, with
`info.json`'s version. Vortex lists it within about two hours; Nexus reviews it after. Never change the name or `id`.

After the first upload, add the extension's Nexus Mods id to `info.json` as `modId` and release again: Vortex ties an
installed extension to its listing by it, so hand-installed copies get updates.

## Licence

MIT: see `LICENSE`.
