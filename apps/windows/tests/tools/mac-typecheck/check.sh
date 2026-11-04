#!/bin/sh
# Type-checks the WinUI app (apps/windows/src/Mimi.App) on macOS / Linux, where the XAML compiler cannot run:
# the XAML pages are skipped and stubs stand in for what the XAML compiler generates (x:Name fields,
# InitializeComponent, Bindings). C# errors are real; XAML itself is NOT checked — build on Windows before a release.
#   apps/windows/tests/tools/mac-typecheck/check.sh        (needs the .NET 10 SDK: DOTNET_ROOT or ~/.dotnet)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../../../src/Mimi.App" && pwd)
STUBS="${TMPDIR:-/tmp}/mimi-xaml-stubs"
export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}" PATH="${DOTNET_ROOT:-$HOME/.dotnet}:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1
# Start from nothing: a stub left from a page that was since deleted would still compile.
rm -rf "$STUBS"
python3 -I "$HERE/xamlstubs.py" "$APP" "$STUBS" >/dev/null
dotnet build -t:Compile "$APP/Mimi.App.csproj" -p:Platform=x64 -p:EnableWindowsTargeting=true \
  -p:CustomAfterMicrosoftCommonTargets="$HERE/override.targets" -p:XamlStubDir="$STUBS" \
  -p:EnableDefaultPageItems=false -p:EnableDefaultApplicationDefinition=false \
  -p:WindowsAppSDKSelfContained=false -p:ApplicationManifest= -p:EnableMsixTooling=false 2>&1 \
  | grep -E "error|warning CS|Build succeeded" | sed -e "s|$APP/||" -e "s|$STUBS/||" -e 's| \[/.*||' | sort -u
