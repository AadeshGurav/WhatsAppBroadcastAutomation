# Senderrr — native Android app

The Route C deployment vehicle from
[`docs/23-android-ndk-migration-prd.md`](../docs/23-android-ndk-migration-prd.md):
one sideloaded APK that runs the whole Senderrr NestJS server on the client's
own phone, with no Termux, no `adb`, and no terminal.

This is a *deployment vehicle*, not a rewrite. The NestJS application, its REST
API, and the dashboard are unchanged; this app is the process that hosts them.

## Build order

The runtime and the application bundle are build artifacts, not checked-in
source, so both have to exist before Gradle can assemble an APK:

```bash
bash scripts/build-libnode.sh    # 1-2 hours cold; writes app/src/main/jniLibs/
bash scripts/package-bundle.sh   # writes app/src/main/assets/bundle.zip
cd android && ./gradlew :app:assembleDebug
```

If you skip the first step, CMake stops with a message telling you to run it —
it does not fall back to a build without a runtime. Skip the second and the app
installs and launches, but tells the client no server software is installed.

## What is in here today

| Layer | State |
|---|---|
| Gradle/Kotlin/Compose shell, theme, launcher icon | done (PRD commit 6) |
| JNI bridge to `node::Start()` + stdout to logcat | done (PRD commit 7) |
| Foreground service in `:noderuntime` | done (PRD commit 8) |
| Watchdog / binder death recipient | done (PRD commit 9) |
| Bundle loader | done (PRD commit 10) |
| Boot receiver + battery-exemption prompt | PRD commit 11 |
| Home and Advanced screens | PRD commits 12-13 |

## Pinned versions

Everything lives in [`gradle/libs.versions.toml`](gradle/libs.versions.toml)
and the pins at the top of
[`../scripts/build-libnode.sh`](../scripts/build-libnode.sh). The NDK version
appears in both on purpose: the app and the `libnode.so` it loads must come
from the same toolchain, and a silent mismatch there is the kind of bug that
only shows up as a link failure on a client's phone.

## Verifying on a real device

The PRD requires a real mid-range phone, not only an emulator — battery
managers, boot receivers, and foreground-service survival are exactly what
emulators do not reproduce. With a device attached over USB debugging:

```bash
cd android && ./gradlew :app:connectedDebugAndroidTest
```

`NodeRuntimeTest` runs a script inside the embedded runtime and asserts its
output reached logcat. That is the spike's acceptance criterion (PRD commit 4).
