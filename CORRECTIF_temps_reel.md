# ✨ Nouveauté v3.2 — Synchronisation TEMPS RÉEL entre les postes

## Ce que ça change, concrètement

Jusqu'ici, quand quelqu'un enregistrait une modification, les autres postes ne la recevaient qu'au retour sur l'onglet ou **au bout d'une minute maximum**. Pendant cette minute, tout le monde travaillait sur une version en retard — c'est dans cette fenêtre que naissaient la plupart des risques de « toucher la même fiche en même temps ».

Maintenant, **le serveur prévient lui-même tous les postes dès qu'un enregistrement arrive**. Mesuré en test : la notification part en **8 millisecondes** ; en conditions réelles (réseau, regroupement), les autres postes sont à jour en **1 à 2 secondes**.

## Ce que ça apporte

- **La fenêtre de conflit passe de ~60 secondes à ~2 secondes.** Deux personnes qui travaillent sur la même zone voient les modifications de l'autre presque instantanément — la probabilité de modifier la même fiche « en même temps » devient minime.
- Quand ta modification de prix part au serveur, **les autres postes l'affichent dans les 2 secondes**.
- Si un poste a des modifications locales au moment où il est prévenu, il les **envoie d'abord** — le serveur fusionne (fiche par fiche, comme d'habitude) au lieu d'écraser.
- L'écran d'accueil, les tableaux et la pastille d'état se rafraîchissent en direct.

## Sécurité et robustesse (rien de fragile)

- **La boucle de 60 secondes est conservée en filet de secours** : si le flux temps réel est coupé (proxy, réseau d'entreprise, vieux navigateur), tout continue de fonctionner exactement comme avant.
- **Reconnexion automatique** en 3 secondes si la connexion tombe ; un battement de cœur toutes les 25 secondes empêche les coupures par les intermédiaires (Railway, box…).
- **Toutes les protections existantes restent actives** : la mise à jour passe par le même circuit qu'avant — fusion fiche par fiche, pas de rechargement pendant le travail dans Facturation HT / Grand Livre / GPAO, garde anti-écrasement.
- **Zéro dépendance** ajoutée (technologie native des navigateurs et de Node.js). Fonctionne à l'identique sur Railway et sur l'EXE local.

## Vérifié par

- **14 tests automatisés temps réel** : notification reçue en 8 ms, deuxième enregistrement également diffusé, événements « déjà vus » ignorés (pas d'aller-retour inutile), modifications locales envoyées avant réception, aucun déclenchement pendant une application en cours.
- **10 tests bout-en-bout** rejoués sur le serveur PostgreSQL (aucune régression), flux temps réel vérifié dans les deux modes de stockage.

## Rappel du plan « zéro conflit »

Cette étape est la **proposition 3** du document PROPOSITIONS_zero_conflit.md. Les prochaines les plus rentables restent : **fusion par champ** (prix et statut de la même commande modifiés par deux personnes → plus aucun conflit) et **journal des prix** (envoi immédiat, historique qui/quand/ancienne valeur, ✓ de confirmation — le modèle bancaire).
