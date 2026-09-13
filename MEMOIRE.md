# Mémoire du projet Randox (ex-RandoCarte, renommé en v24)

**Marque** : Randox — « Explorez plus loin ». Logo : montagne verte + chemin sinueux + soleil sur carré vert sombre ([icon.svg](icon.svg)). Accent UI `#a3d65c` (texte sombre dessus), fonds vert très sombre. Les noms internes (base IndexedDB `randocarte`, dépôt GitHub) ne changent pas — compatibilité des données.

*Dernière mise à jour : 25 juillet 2026 — version v16*

## Le projet en une phrase

Web app (PWA) **gratuite et 100 % hors ligne** de randonnée, façon Visorando : traces GPX et cartes IGN/satellite préparées à la maison avec du réseau, puis utilisées en montagne en mode avion, avec GPS, direction et dénivelé en temps réel.

**En ligne :** https://remjeannin-arch.github.io/randocarte/ (GitHub Pages, dépôt `remjeannin-arch/randocarte`)

---

## Fonctionnalités réalisées

### Cartes
- 4 fonds : **Plan IGN** (topo), **Satellite IGN** (France uniquement), **Satellite Esri** (monde), **OpenTopoMap** (topo monde).
- Téléchargement de zones pour le hors-ligne : cadrage à l'écran, choix du niveau de détail (zoom 12→17), estimation tuiles/Mo avant lancement, progression, annulation, limite de sécurité 40 000 tuiles.
- Cache automatique des tuiles vues en naviguant (désactivable).
- Stockage IndexedDB (clé `fond|z|x|y`), compteur de tuiles + espace utilisé, bouton de purge.
- Message explicatif quand un fond ne couvre pas la zone (IGN hors de France / zone non téléchargée).

### Traces
- Import GPX (Visorando, etc.), multi-traces, couleurs, affichage/masquage, suppression, export GPX (avec balises `<time>` si présentes).
- **Récupération automatique des altitudes IGN** (service Géoplateforme `data.geopf.fr/altimetrie`) quand le GPX n'en contient pas — à l'import et en rattrapage à l'ouverture.
- **Tracé manuel** : points posés au doigt, distance en direct, annulation point par point ; à la validation, densification (~1 pt/40 m) + altitudes IGN.
- Fiche façon Visorando : distance, durée estimée (méthode du randonneur), difficulté estimée (indice d'effort), boucle oui/non, D+/D−, points haut/bas, coordonnées du départ (copiables), liens itinéraire voiture.
- **Calcul D+/D−** : rééchantillonnage à pas constant 20 m + hystérésis à ancre mobile seuil 10 m (réglage type Visorando) — insensible à la densité de points du fichier source, validé par tests synthétiques.

### Navigation en rando
- GPS temps réel : point bleu, cercle de précision, **cône de direction** (boussole ou cap GPS), recentrage auto débrayable.
- Bandeau : vitesse, altitude, précision, **écart à la trace** (vert/orange/rouge), **D+ fait**, **D− fait**, distance **restante**.
- **Profil altimétrique interactif** : quadrillage km/altitude, position GPS en direct sur la courbe, curseur bidirectionnel (toucher la trace → point sur le profil ; glisser sur le profil → marqueur sur la carte) avec étiquette km · alt · D+ · D−.
- Point de départ cliquable + **appui long n'importe où** : coordonnées GPS, copie presse-papiers, itinéraire voiture **Plans** / **Google Maps**.
- Écran toujours allumé (wake lock), indicateur en ligne/hors ligne.

### Robustesse
- PWA installable (manifest + service worker), démarrage 100 % hors ligne.
- SW : réseau d'abord pour la page (mises à jour rapides), cache d'abord pour le reste.
- **Mode sans échec** : 1 plantage au démarrage → vue réinitialisée ; 2 → traces non dessinées. Compteur `rc.bootfail`.
- Erreurs JS affichées à l'écran ; numéro de version dans Options.

---

## Leçons techniques (à ne pas oublier)

1. **Safari iOS tue les pages gourmandes en mémoire** (« Un problème récurrent est survenu ») :
   - ne jamais matérialiser de liste proportionnelle à la zone visible (comptage de tuiles = arithmétique) ;
   - tracés Leaflet en **canvas** (`preferCanvas`), pas en SVG (GPX de milliers de points).
2. **PWA iOS** : `target="_blank"` échoue en silence en mode installé ; `contextmenu` jamais émis à l'appui long (détection manuelle nécessaire) ; toucher fiable = marqueurs DOM, pas canvas (ou `L.canvas({tolerance:14})`) ; **pas de GPS en arrière-plan** (limite Apple, insoluble en web).
3. **Mise à jour PWA** : bumper `APP_VERSION` (app.js) **et** `VERSION` (sw.js) à chaque livraison ; vérifier le numéro dans Options avant de diagnostiquer.
4. **IGN** : tuiles et altimétrie gratuites sans clé via `data.geopf.fr`, mais couverture France uniquement (sauf ressource altimétrie `ign_rge_alti_wld`).
5. **D+ : le seuil s'applique par ancre mobile, jamais entre points consécutifs**, et le résultat dépend de la densité → rééchantillonner à pas constant. D+ ≠ D− sur une boucle est normal.

---

## Idées d'évolutions

### Vite faites, utiles tout de suite
- **Points d'intérêt personnels** : appui long → « Enregistrer ce point » (nom + emoji : parking, source, refuge, bivouac), stockés hors ligne, exportés dans le GPX.
- **Échelle de distance** sur la carte (L.control.scale) et **repères kilométriques** le long de la trace (1, 2, 3 km…).
- **Alerte d'écart** : vibration/bip quand on s'éloigne de plus de X m de la trace (utile tête baissée dans la montée).
- **Gestion des zones téléchargées** : liste nommée (« Etna », « Vanoise ») avec taille et suppression zone par zone, au lieu du tout-ou-rien actuel.
- **Recherche de lieu** (géocodage Nominatim, en ligne) pour cadrer une zone sans naviguer à la main.
- **Pente colorée** sur le profil et la trace (vert/jaune/rouge selon le %) — les données sont déjà là.
- **Stats de session** simples (sans enregistrement complet) : heure de départ, temps écoulé, distance parcourue depuis l'ouverture.

### Inspiration AllTrails pour le futur mode enregistrement (captures fournies par l'utilisateur, sept. 2026)
- Feuille basse d'enregistrement : grille de stats (Temps, Distance, D+, Restant, Rythme, Vitesse) + gros bouton vert « Commencer ».
- Choix de l'**activité** (rando, trail, VTT…) qui adapte les calculs de durée.
- **Partage en direct** de la position avec un proche.
- **Virage par virage** et **navigation vocale** le long de la trace.
- **Mise en pause automatique** à l'arrêt.
- « Maintenir l'écran allumé » comme réglage de session (déjà présent dans Randox, à regrouper ici).
- Sélecteur de fonds avec **vignettes d'aperçu** (Carte de base / Calques / Extras).

### Chantier moyen — la bascule native (Capacitor)
- Transformer la PWA en **app iPhone native** (Capacitor) : tout le code actuel réutilisé.
- Débloque : **GPS en arrière-plan téléphone verrouillé** → réactiver l'**enregistrement de trace** (retiré en v15, code complet dans l'historique git v13 : stats temps réel, pause, anti-crash, GPX horodaté compatible Strava) avec en plus l'altimètre baromètre du téléphone.
- Prérequis : Xcode + compte Apple Developer (gratuit = réinstallation hebdo ; 99 €/an = permanent, apps illimitées, TestFlight).
- Usage perso : **aucune validation Apple nécessaire**.

### Plus ambitieux
- **Cartes vectorielles hors ligne (PMTiles)** : la France topo entière en ~quelques Go au lieu de tuiles image — téléchargement par département, rendu MapLibre, zoom infini.
- **Routage sur sentiers** (BRouter/GraphHopper) : tracé qui s'accroche aux chemins comme Visorando, voire recalcul hors ligne.
- **Météo du point de départ** (Open-Meteo, gratuit sans clé) affichée dans la fiche avant de partir.
- **Partage d'urgence** : bouton qui prépare un SMS avec position actuelle et lien carte.
- **Bibliothèque de randos** : dossiers, favoris, historique des sorties, synchronisation entre appareils via export/import de sauvegarde.
- **Publication App Store** si l'app native fait ses preuves (attention : règle « minimum functionality » d'Apple et licences des fonds de carte à vérifier pour une diffusion publique).

---

## Journal des versions

| Version | Contenu |
|---|---|
| v1 | App initiale : cartes hors ligne, GPX, GPS, PWA, déploiement GitHub Pages |
| v2-v4 | Tracé manuel + altitudes IGN, profil interactif, D+/D− temps réel, fiche Visorando, D− |
| v5 | Méthode D+/D− : rééchantillonnage 20 m + hystérésis 10 m (validée par tests) |
| v6 | **Fix plantage iOS** : comptage de tuiles arithmétique ; SW réseau d'abord |
| v7-v8 | Ouverture d'une trace au toucher ; **rendu canvas**, mode sans échec, erreurs visibles |
| v9 | Messages « fond non couvert » (IGN hors France / zone non téléchargée) |
| v10-v12 | Départ cliquable → itinéraire voiture ; tolérance tactile ; appui long coordonnées + copie |
| v13-v14 | Enregistrement de trace façon Strava ; fixes toucher/liens iOS |
| v15 | **Retrait de l'enregistrement** (mis de côté pour la version native) |
| v16 | Appui long manuel Safari + schéma `maps://` pour Plans |
| v17 | Niveaux de zoom à la carte (cases + coûts + préréglages), fond de secours inter-niveaux, sélecteur rapide de fond 🗺️, zoom courant affiché |
| v18 | Barre d'onglets permanente en bas (dépliable au doigt), FAB ✏️ tracer, **édition de trace** (déplacer/insérer/supprimer/prolonger des points, recalcul altitudes) |
| v19 | Explication du stockage navigateur + **sauvegarde fichier .rcz** (cartes + traces exportées « en dur » dans Fichiers/Téléchargements, réimportables sur tout appareil) |
| v20 | Suppression barre du bas, panneau via ☰ ; app.js réseau d'abord + rechargement auto (fin des décalages interface/code) |
| v21 | Projection continue de la position sur la trace + panneau Parcouru/Restant (km, D+/D−, temps restant estimé) |
| v22 | **Relief 2D** (estompage mondial Esri, fondu multiply, inclus dans les téléchargements ≤ z14) + **Vue 3D** (3d.html : MapLibre GL, terrain Terrarium AWS, fond satellite/IGN drapé, trace, survol animé — prototype en ligne) |
| v23 | Vue 3D : position GPS, profil altimétrique interactif, curseurs synchronisés relief ↔ courbe |
| v24 | **Rebranding Randox** (logo, accent vert, tagline) ; design AllTrails-like (verre dépoli, deux grappes de boutons, bouton 3D sur la carte, échelle, onglets pilule) ; **icônes SVG** partout (fin des emoji) ; **tracé au doigt dans la vue 3D** (brouillon finalisé par l'app : altitudes + stats) ; qualité 3D (terrain z14, anticrénelage, ombrage) |
| v25 | **Catalogue de randos de démonstration** (demos/*.gpx + index.json) : 3 parcours réels issus d'OSM (ODbL, attribution) + altitudes IGN — Cirque de Gavarnie, Trou de la Bombe (Bavella), Puy de Dôme — avec fiche et ajout en un bouton. Refus de copier Visorando (contenu propriétaire). Script de fabrication : scratchpad build-demos.js |
| v26 | Option **« Noms des sommets et cols »** (OSM Overpass, cache IndexedDB `pois` pour le hors-ligne, tri par altitude, max 30-120 selon zoom, aussi récupérés au téléchargement de zone) ; base IndexedDB passée en version 2 ; rotation 2D refusée (plugin risqué) — la 3D tourne déjà |
| v27 | **Sommets nommés dans la vue 3D** façon PeakVisor (marqueurs DOM MapLibre posés sur le relief, mêmes données OSM/cache pois que la 2D, bouton dédié, tri par altitude max 40-70) |
| v28 | Correctif étiquettes 3D (emprise stable autour du centre caméra, miroirs Overpass) + **Panorama façon PeakFinder** (panorama.html : silhouette d'horizon 360° calculée par lancer de rayons sur le DEM Terrarium z10 avec bandes de profondeur, sommets OSM visibles étiquetés, orientation au doigt ou boussole, tuiles DEM cachées en IDB `dem10|…`) |
