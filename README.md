# FenceMapper

Application web / smartphone (PWA installable) pour **concevoir et poser des clôtures temporaires Kiwitech** dans les champs.

## Fonctions

**Conception (sur ordinateur ou téléphone)**
- Carte satellite (IGN, Esri) ou plan, dessin du champ (polygone/rectangle) et de clôtures (lignes), accrochage aux sommets.
- Génération de clôtures de subdivision parallèles, par largeur de bande (m) ou par surface (ares), pour tout type de forme de champ ; direction réglable ou alignée sur le plus long côté ; choix du côté de départ ; clôture du périmètre en option.
- Surface de chaque bande, longueur totale, nombre de piquets et longueur de fil estimés.
- Sauvegarde automatique dans le navigateur, export / import GeoJSON.

**Terrain (sur le quad)**
- Choix d'une clôture (ou la plus proche automatiquement), puis guidage GPS : grande flèche d'écart latéral (gauche / droite), distance au prochain piquet, longueur restante, précision GPS.
- Compteur de piquets posés, écran maintenu allumé, fonctionnement hors ligne pour les zones déjà affichées.
- Mode « Simuler » (clic sur la carte) pour tester sans GPS.

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
