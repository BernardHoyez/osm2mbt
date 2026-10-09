# osm2mbt

**Progressive Web App** permettant de :

- Afficher un fond cartographique OpenStreetMap (standard, France / toponymie française, Humanitarian)
- Charger optionnellement un fichier **GPX** ou **KML** (traces et waypoints)
- Effectuer une **sélection rectangulaire** redimensionnable
- Choisir les **niveaux de zoom** (min / max)
- Produire et télécharger un fichier **MBTiles** (raster PNG)
- Fonctionner hors-ligne partiellement grâce à un **Service Worker** à caches versionnés (brise-caches)
- Être déployée en statique sur **GitHub Pages**

## Avertissement important

La génération d’un MBTiles à partir des tuiles publiques d’OpenStreetMap constitue un **téléchargement massif**.  
Cela **contrevient à la [politique d’utilisation des tuiles OSM](https://operations.osmfoundation.org/policies/tiles/)**.

- Limitez-vous à de **très petites zones** et de bas niveaux de zoom.
- Préférez un serveur de tuiles que vous contrôlez (TileServer-GL, MapTiler, votre propre rendu, etc.).
- L’outil est fourni à des fins éducatives et de tests locaux.

## Utilisation

1. Ouvrez `index.html` (ou la version déployée).
2. Choisissez le fond cartographique (OSM / OSM France / HOT).
3. (Optionnel) Chargez un GPX ou KML.
4. Cliquez sur **Sélection rect.** puis redimensionnez le rectangle.
5. Réglez Z min et Z max.
6. Cliquez sur **Générer MBTiles** → le fichier est téléchargé.

## Déploiement GitHub Pages

```bash
# Depuis la racine du dépôt
git init
git add .
git commit -m "osm2mbt PWA"
git branch -M main
git remote add origin https://github.com/<user>/osm2mbt.git
git push -u origin main
```

Dans les paramètres du dépôt → Pages → Source : branch `main` / root (ou `/docs` si vous préférez).

L’URL sera `https://<user>.github.io/osm2mbt/`.

## Structure

```
osm2mbt/
├── index.html
├── manifest.json
├── sw.js                 # Service Worker (caches versionnés)
├── css/style.css
├── js/app.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

## Technologies

- Leaflet 1.9 + leaflet-areaselect
- @mapbox/togeojson (GPX/KML)
- sql.js (SQLite WASM) pour l’écriture du format MBTiles
- Service Worker natif (pas de Workbox) avec stratégie network-first pour le HTML et cache-first pour les assets

## Licence

Code source : MIT.  
Données cartographiques : © contributeurs OpenStreetMap (ODbL).
