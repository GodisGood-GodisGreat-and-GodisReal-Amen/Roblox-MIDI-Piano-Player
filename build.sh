#!/bin/bash
# Builds "Roblox MIDI Piano Player.app" from the files in this folder.
#
#   ./build.sh             build/Roblox MIDI Piano Player.app
#   ./build.sh --install   ...and put it in /Applications
#   ./build.sh --zip       ...and make build/Roblox-MIDI-Piano-Player-<version>.zip
#   ./build.sh --readable  put src/main.js in the app as it is (for debugging)
#
# Nothing is compiled: the app is a JavaScript for Automation script
# (src/main.js) in an app bundle, started by a small shell launcher. The app
# gets a compact copy of the script, without comments or indentation, made
# and checked token by token by tools/minify.js.
set -euo pipefail
cd "$(dirname "$0")"

READABLE=0
for arg in "$@"; do
  [ "$arg" = "--readable" ] && READABLE=1
done

NAME="Roblox MIDI Piano Player"
APP="build/$NAME.app"
VERSION="$(/usr/bin/sed -n 's/^var APP_VERSION = "\(.*\)";$/\1/p' src/main.js)"
PLIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' app/Info.plist)"
if [ "$VERSION" != "$PLIST_VERSION" ]; then
  echo "Version mismatch: src/main.js says $VERSION, app/Info.plist says $PLIST_VERSION." >&2
  exit 1
fi

# Syntax check: osacompile parses the whole script and stops on any error.
mkdir -p build
/usr/bin/osacompile -l JavaScript -o "build/.syntax-check.scpt" src/main.js
rm -f "build/.syntax-check.scpt"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp app/Info.plist "$APP/Contents/Info.plist"
cp app/RobloxMidiPianoPlayer "$APP/Contents/MacOS/RobloxMidiPianoPlayer"
chmod 755 "$APP/Contents/MacOS/RobloxMidiPianoPlayer"
cp app/AppIcon.icns app/README.txt "$APP/Contents/Resources/"
if [ "$READABLE" = 1 ]; then
  cp src/main.js "$APP/Contents/Resources/main.js"
else
  /usr/bin/osascript -l JavaScript tools/minify.js src/main.js "$APP/Contents/Resources/main.js" \
    "Roblox MIDI Piano Player $VERSION, compact build of src/main.js (public domain): https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player" > /dev/null
  /usr/bin/osacompile -l JavaScript -o "build/.syntax-check.scpt" "$APP/Contents/Resources/main.js"
  rm -f "build/.syntax-check.scpt"
fi
# The demo songs of File › Demo Songs.
mkdir -p "$APP/Contents/Resources/demo"
cp docs/demo/*.mid "$APP/Contents/Resources/demo/"
/usr/bin/xattr -cr "$APP"
echo "Built $APP (v$VERSION)"

for arg in "$@"; do
  case "$arg" in
    --install)
      DEST="/Applications/$NAME.app"
      if [ -d "$DEST" ]; then
        # Update the files inside the existing bundle rather than replacing
        # the bundle, so macOS keeps the Accessibility permission it gave it.
        cp "$APP/Contents/Info.plist" "$DEST/Contents/Info.plist"
        cp "$APP/Contents/MacOS/RobloxMidiPianoPlayer" "$DEST/Contents/MacOS/RobloxMidiPianoPlayer"
        cp -R "$APP/Contents/Resources/" "$DEST/Contents/Resources/"
        /usr/bin/touch "$DEST"
      else
        /usr/bin/ditto "$APP" "$DEST"
      fi
      echo "Installed $DEST"
      ;;
    --readable)
      ;;
    --zip)
      ZIP="build/Roblox-MIDI-Piano-Player-$VERSION.zip"
      rm -f "$ZIP"
      /usr/bin/ditto -c -k --norsrc --noextattr --noacl --keepParent "$APP" "$ZIP"
      echo "Zipped $ZIP"
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done
