# ✅ Correctif — Impression GPAO, rapport Qualité vide, couleurs d'impression

## 1. Impression GPAO : l'état de production journalier est maintenant complet

**Le problème.** La page d'impression lisait la liste des ouvrières de la **chaîne telle qu'elle est aujourd'hui**, au lieu des ouvrières **de la journée imprimée**. Dès que la composition avait bougé (ouvrière ajoutée/retirée du jour, fusion de matricules, journée dupliquée…), les identifiants ne correspondaient plus aux saisies : le rapport sortait presque vide, sans les saisies horaires de l'opératrice.

**Le correctif.** L'impression lit désormais **exactement la même source que l'écran de saisie** : les ouvrières de la journée, avec toutes leurs saisies heure par heure. Concrètement, le rapport imprimé montre maintenant : les pièces saisies par heure pour chaque ouvrière, les mentions **RI / ABS** (heures exclues de l'objectif), les heures **multi-postes** (total cumulé, marqué d'un astérisque), le total, l'objectif ajusté, le rendement (en couleur), les retouches. Si la journée n'a aucune ouvrière, le rapport l'écrit clairement au lieu d'afficher un tableau muet.

## 2. Contrôle Qualité PF : plus jamais de rapport qui disparaît

**Le problème trouvé.** Les photos insérées dans les inspections sont stockées dans la mémoire du navigateur, qui est **limitée (~5 Mo)**. Quand l'agent ajoutait plusieurs photos, cette limite était dépassée : l'enregistrement échouait **en silence** (juste un petit message discret). Tout paraissait normal à l'écran… mais rien n'était réellement enregistré, et au rechargement, le travail avait disparu — d'où le rapport vide.

**Les correctifs.**
- **Filet de sécurité principal : quand le stockage du navigateur est plein, le travail part maintenant directement au serveur** depuis la mémoire. Rien n'est perdu : au prochain démarrage, le poste récupère ses données depuis le serveur.
- **Alerte impossible à rater** : un bandeau rouge s'affiche en haut de l'écran expliquant que le stockage est plein, que les données partent au serveur, et qu'il faut attendre la pastille verte avant de fermer. Le bandeau disparaît dès que la situation redevient normale.
- **Photos plus légères** (560 px, compression renforcée) : environ 30 % de place en moins par photo, sans perte de lisibilité pour un rapport.
- **La duplication d'inspection ne copie plus les photos** (elles concernent l'inspection d'origine et doublaient l'espace consommé pour rien).

## 3. Impressions en couleur partout

**Le problème.** Les navigateurs suppriment par défaut les couleurs de fond à l'impression pour économiser l'encre — d'où des documents fades ou noir et blanc.

**Le correctif.** Tous les documents imprimés de l'application forcent maintenant la conservation des couleurs (`print-color-adjust`) :
- les **15 documents d'impression** du module principal (listes de commandes, prévision export, nomenclatures, costing, traçabilité, matières, QR, rapports qualité…),
- l'**impression directe** des pages de l'application,
- les impressions de **GPAO Production** (rapport journalier, avec rendements colorés vert/orange/rouge),
- les impressions de **Facturation HT** et du **Grand Livre**.

> Astuce : dans la fenêtre d'impression du navigateur, vérifiez aussi que l'option « Graphiques d'arrière-plan » est cochée si votre navigateur la propose — certains l'imposent en plus du réglage de l'application.

## Comment ça a été vérifié

- **27 tests automatisés** sur les correctifs : le rapport GPAO reconstruit avec le cas exact qui produisait la page vide (ouvrières de la journée différentes de la chaîne), le mécanisme de secours quand le stockage est plein (les données partent bien au serveur), la duplication sans photos, et la présence des couleurs dans les trois mini-applications.
- **17 blocs de code** du fichier vérifiés syntaxiquement après modification.
- Serveur démarré en conditions réelles : le fichier servi est strictement identique au fichier corrigé.

## Ce qui ne change pas

- Vos données, la synchronisation, la fusion fiche par fiche, les rôles : inchangés.
- Le serveur (v3.0 PostgreSQL/fichier) : inchangé dans cette livraison.
- Aucune ressaisie nécessaire : les journées GPAO et inspections existantes s'impriment correctement avec le correctif.
