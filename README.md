# Fency

Application web / smartphone (PWA installable) pour **concevoir et poser des clôtures temporaires Kiwitech** dans les champs.

## Fonctions

**Conception (sur ordinateur ou téléphone)**
- Fonds de carte : satellite IGN, Esri, plan OSM, Sentinel-2 (indice SAVI, via Sentinel Hub).
- Parcelles : dessin (polygone/rectangle), ou création en cliquant un polygone d'une couche de référence WFS (RPG de l'IGN) ; fusion de parcelles voisines (les espaces de moins de 5 m sont comblés) et découpe par un trait.
- Clôtures dessinées à la main (lignes), accrochage aux sommets.
- Génération de clôtures de subdivision parallèles, par largeur de bande (m) ou par surface (ares), pour tout type de forme de champ ; direction réglable ou alignée sur le plus long côté ; choix du côté de départ ; clôture du périmètre en option.
- Surface de chaque bande, longueur totale, nombre de piquets et longueur de fil estimés.
- Plusieurs plans nommés, enregistrés automatiquement ; export / import GeoJSON.
- Stockage et authentification modulables (local par défaut, Firebase, autre hébergeur) pour le travail collaboratif : voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Terrain (sur le quad)**
- Choix d'une clôture (ou la plus proche automatiquement), puis guidage GPS : grande flèche d'écart latéral (gauche / droite), distance au prochain piquet, longueur restante, précision GPS.
- Compteur de piquets posés, écran maintenu allumé, fonctionnement hors ligne pour les zones déjà affichées.
- Mode « Simuler » (clic sur la carte) pour tester sans GPS.

## Application Android avec correction RTK

Le dossier `android/` contient une application Android (Kotlin, sans AndroidX) qui embarque
l'interface web et lui fournit une position corrigée. Trois sources au choix (écran « ⚙ RTK ») :

| Source | Principe | Précision attendue |
|---|---|---|
| RTK téléphone | mesures GNSS brutes d'Android + corrections NTRIP + RTKLIB (JNI) | 10 à 50 cm au mieux, si le téléphone fournit la phase |
| Récepteur externe | NMEA d'un récepteur RTK Bluetooth (simpleRTK2B, Emlid Reach…), corrections NTRIP retransmises | 1 à 2 cm |
| GPS standard | position Android | 2 à 5 m |

**Chaîne RTK téléphone**
1. `RawGnssSource` : `registerGnssMeasurementsCallback`, suivi complet (`setFullTracking`) à partir d'Android 12.
2. `RawConverter` : conversion `GnssClock`/`GnssMeasurement` en pseudo-distance, phase (ADR/λ), Doppler, C/N0, saut de cycle ; GPS, Galileo, BeiDou, QZSS ; L1/E1, L5/E5a, B1I.
3. `NtripClient` : NTRIP v1 et v2 (chunked), reconnexion, envoi de GGA, choix de la base la plus proche dans le sourcetable (Centipede par défaut).
4. `cpp/fm_rtk.c` : RTKLIB demo5 (rtklibexplorer, tag b34k), mode cinématique, fix-and-hold, position de base issue des messages 1005/1006.
5. L'écran « Diagnostic du téléphone » indique si la phase porteuse et la bi-fréquence sont disponibles.

**Tests**
- `android/app/src/test` : tests JVM (conversion des mesures, RTCM3/CRC-24Q, NMEA, NTRIP v1/v2, sourcetable).
- `android/app/src/main/cpp/test/test_bridge.c` : test de bout en bout du moteur sur les données réelles de RTKLIB (deux stations GSI à 3 km). La base passe par un vrai flux RTCM3 MSM4, le mobile par l'API du pont. Résultat : 109 époques FIXES sur 120, écart horizontal maximal de 4,2 cm par rapport au post-traitement RTKLIB.

**Obtenir l'APK** : scannez ce code avec le téléphone (ou ouvrez https://github.com/MartinCuypers/Fency/releases/latest/download/fency.apk), puis installez le fichier en autorisant les sources inconnues. Chaque push sur `main` met la version à jour (`.github/workflows/android.yml`).

<img src="docs/qr-apk.png" alt="QR code de téléchargement de l'APK Fency" width="220">

**Compiler soi-même** : Android Studio (SDK 35, NDK, CMake 3.22) ; lancer d'abord `npm run build` à la racine, puis ouvrir `android/`.

## Développement

```bash
npm install
npm run dev      # serveur local
npm test         # tests de la géométrie et du guidage
npm run build    # production dans dist/
```

Le GPS exige HTTPS (ou localhost) : le déploiement GitHub Pages fourni dans `.github/workflows/deploy.yml` convient.
Pour une précision de 2 à 5 cm sur le quad, associer un récepteur RTK Bluetooth : le téléphone l'utilise comme source de position.

## Structure

- `src/geo.js` : projection locale, surfaces, longueurs
- `src/generate.js` : découpage d'un champ en bandes
- `src/guidance.js` : écart latéral, piquets, estimation de matériel
- `src/main.js` : carte et interface
