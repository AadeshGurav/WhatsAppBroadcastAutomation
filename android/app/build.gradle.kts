plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.senderrr.app"
    compileSdk = 36

    // Pinned to the NDK scripts/build-libnode.sh cross-compiles libnode.so
    // with. The app and the runtime it loads must come from the same toolchain.
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.senderrr.app"
        // API 28 skips the aligned_alloc shim Termux's recipe only needs below
        // 28 (PRD ADR-3). Raising or lowering this means re-checking that.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // libnode.so is built for arm64 only; every phone this ships to is
            // arm64. Adding an ABI means another 1-2 hour libnode build.
            abiFilters += "arm64-v8a"
        }

        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    // Building the JNI bridge needs libnode.so, which takes a couple of hours to
    // cross-compile. Someone working on the UI should not have to wait for it,
    // so -Psenderrr.skipNativeRuntime=true leaves it out. The resulting APK
    // installs and runs, and tells the client its server runtime is missing
    // rather than crashing - NodeRuntime keeps the load failure as a value for
    // exactly this reason. Never use it for a build anyone will actually run a
    // server on.
    if (!project.hasProperty("senderrr.skipNativeRuntime")) {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    } else {
        logger.warn(
            "senderrr.skipNativeRuntime is set: this APK will have NO server " +
                "runtime in it. UI builds only."
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        compose = true
    }

    androidResources {
        // bundle.zip is already stored uncompressed by scripts/package-bundle.sh;
        // re-deflating it in the APK only costs the phone CPU on every read.
        noCompress += "zip"
    }

    packaging {
        jniLibs {
            // libnode.so must stay a real file on disk: the JNI bridge dlopen()s
            // it from nativeLibraryDir, and an extracted .so is also what makes
            // the W^X exec path work for the tunnel binary later (PRD commit 15).
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
