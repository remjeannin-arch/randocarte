# RandoCarte — cartes & GPX 100 % hors ligne

Web app (PWA) gratuite de suivi de randonnée, façon Visorando mais entièrement hors ligne :

- **Traces GPX** importées à l'avance (depuis Visorando, AllTrails, etc.), avec distance, D+/D−, profil altimétrique.
- **Cartes téléchargeables** : Plan IGN (topo), Satellite IGN, Satellite Esri, OpenTopoMap — stockées sur le téléphone.
- **Position GPS temps réel** avec cône de direction (boussole), vitesse, altitude, précision.
- **Navigation** : écart à la trace (vert/orange/rouge) et distance restante.
- Recentrage auto, écran toujours allumé (wake lock), fonctionne en **mode avion**.

## Mise en ligne (nécessaire une seule fois)

L'app doit être servie en **HTTPS** pour que le GPS et le mode hors ligne fonctionnent sur téléphone. Deux options gratuites :

1. **Netlify Drop** (le plus simple) : ouvrir <https://app.netlify.com/drop> et glisser-déposer ce dossier. Une URL `https://….netlify.app` est créée immédiatement.
2. **GitHub Pages** : pousser ce dossier dans un dépôt, activer Pages dans les réglages.

## Utilisation

1. Ouvrir l'URL sur le téléphone, puis **installer l'app** :
   - iPhone : Safari → Partager → « Sur l'écran d'accueil »
   - Android : Chrome → menu ⋮ → « Installer l'application »
2. **Avant la rando (avec réseau)** :
   - Onglet *Traces* → importer le fichier GPX.
   - Onglet *Cartes* → choisir le fond, cadrer la zone de la rando, régler le niveau de détail (16 = bon compromis, 17 = très fin), puis « Télécharger la zone affichée ». Répéter pour un second fond (ex. Plan IGN **et** satellite) si souhaité.
3. **Pendant la rando (sans réseau)** : ouvrir l'app, toucher 🧭. La flèche bleue indique votre direction ; le bandeau du haut affiche vitesse, altitude, écart à la trace et distance restante.

## Notes techniques

- Tuiles stockées dans IndexedDB (clé `couche|z|x|y`), traces GPX parsées et stockées de même ; l'app elle-même est mise en cache par le service worker ([sw.js](sw.js)).
- Fonds IGN servis par la Géoplateforme (`data.geopf.fr`, libre et sans clé), Esri World Imagery, OpenTopoMap.
- Aucun serveur, aucun compte, aucune donnée transmise : tout reste sur l'appareil.
- Testable en local : `python3 -m http.server` dans ce dossier puis <http://localhost:8000> (le GPS marche sur `localhost` sans HTTPS).
