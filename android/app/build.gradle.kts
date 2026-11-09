plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.martincuypers.fencemapper"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.martincuypers.fencemapper"
        minSdk = 24          // mesures GNSS brutes : Android 7+
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.0"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=none") } }
    }

    signingConfigs {
        // Clé de debug commune versionnée : les APK successifs s'installent par-dessus les précédents.
        getByName("debug") {
            storeFile = rootProject.file("keystore/debug.keystore")
            storePassword = "android"; keyAlias = "androiddebugkey"; keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/www"))
}

// L'interface web (dossier racine du dépôt, `npm run build`) est embarquée dans l'APK.
val copyWeb by tasks.registering(Copy::class) {
    from(rootProject.file("../dist"))
    into(layout.buildDirectory.dir("generated/www/www"))
}
tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    testImplementation("junit:junit:4.13.2")
}
