# 🏦 Propositions — Vers le « zéro conflit » et des enregistrements de niveau bancaire

## Où on en est déjà

Les étapes précédentes ont réglé le plus gros : fusion automatique fiche par fiche (deux personnes sur deux commandes différentes ne se gênent plus jamais), garde anti-écrasement côté serveur, secours quand le stockage du navigateur est plein, sauvegardes horaires, et stockage PostgreSQL par module.

## Ce qui peut ENCORE provoquer un conflit ou une perte de temps aujourd'hui

1. **Même fiche, champs différents.** Tu changes le **prix** de la commande 207 pendant que quelqu'un change son **statut** → la fusion actuelle compare la fiche entière et déclare un conflit, alors que vous n'avez pas touché au même champ. C'est la cause n°1 des conflits restants.
2. **La fenêtre de retard.** Ta modification part au serveur 2,5 s après ta saisie, mais les autres postes ne la reçoivent que dans la minute (ou au retour sur l'onglet). Pendant ce temps, ils travaillent sur une version vieille de 60 s — ce qui augmente la probabilité de toucher la même fiche « en même temps ».
3. **Pas d'accusé de réception visible par action.** La pastille générale (vert/orange) existe, mais quand tu attribues un prix, rien ne te dit « CE prix précis est bien arrivé au serveur ».
4. **Pas d'historique par champ.** Si un prix est écrasé, on ne sait ni qui, ni quand, ni quelle était l'ancienne valeur.

## Comment font les banques (et pourquoi elles ne perdent rien)

Une banque n'échange pas des copies de dossiers entre agences. Chaque geste est un **ordre horodaté** (« virer 100 DT, compte X → Y, 10h32, agent Z ») inscrit dans un **journal central ordonné**. Le solde n'est jamais « fusionné » : il découle du journal. Deux agences peuvent agir sur le même compte à la même seconde — le serveur central ordonne les deux transactions, et l'historique garde tout. **C'est ce modèle qu'on va appliquer à tes prix.**

---

## Les propositions (par ordre de gain / effort)

### Proposition 1 — Fusion par CHAMP ⭐ élimine la cause n°1

Quand la même fiche a été modifiée des deux côtés, comparer **champ par champ** (prix_vente, prix_facon, statut, note, dates…). Un conflit n'est déclaré que si **le même champ de la même fiche** a été changé différemment des deux côtés — cas rarissime en pratique.

- Ton scénario exact (toi sur le prix, une collègue sur le statut de la même commande) → **fusion automatique, zéro interruption**.
- Effort : moyen (extension du moteur de fusion existant, très testable).
- Risque : faible — les cas dangereux (même champ modifié deux fois) restent signalés.

### Proposition 2 — Journal des prix, le modèle bancaire ⭐ la réponse de fond

Chaque modification de prix devient une **transaction** :

```
Commande 207 · prix_vente : 8,20 → 8,50 · par MOUNA · le 07/08 à 10:32:05
```

- **Envoi immédiat** : les changements de prix partent au serveur **à la seconde**, sans attendre les 2,5 s (les autres champs gardent le rythme actuel).
- **Journal central dans PostgreSQL** : le serveur inscrit chaque transaction dans l'ordre d'arrivée. En cas de course sur le même prix, la règle est claire et automatique — la dernière transaction reçue gagne, et **rien n'est perdu** : l'ancienne valeur reste dans le journal.
- **Accusé de réception visible** : le champ prix affiche un petit ✓ vert dès que le serveur a confirmé l'écriture — comme un paiement validé.
- **Historique consultable sur chaque commande** : qui a changé quel prix, quand, ancienne → nouvelle valeur, avec restauration en un clic d'une valeur précédente.
- Effort : moyen-plus. C'est la vraie réponse à « une banque ne perd pas ses données ».

### Proposition 3 — Synchronisation temps réel (le serveur prévient les postes)

Aujourd'hui les postes « demandent » les nouveautés toutes les 60 s. Avec les notifications temps réel (Server-Sent Events, natif, zéro dépendance), le serveur **pousse** chaque changement vers tous les postes en 1 à 2 secondes.

- La fenêtre pendant laquelle deux personnes peuvent se marcher dessus passe de ~60 s à ~2 s → les conflits résiduels deviennent quasi impossibles.
- Bonus : l'écran TV GPAO et les tableaux de bord se mettent à jour en direct.
- Effort : moyen (serveur + client), compatible EXE local et Railway.

### Proposition 4 — Présence : « MOUNA modifie cette commande »

Quand deux personnes ouvrent la même fiche, un bandeau discret l'indique en temps réel. On **prévient** le conflit au lieu de le guérir. S'appuie sur la proposition 3.

### Proposition 5 — Écriture fiche par fiche vers PostgreSQL (plus tard, avec l'app DBS)

Aujourd'hui chaque poste envoie tout l'état (~2 Mo compressés). À terme : n'envoyer que **les fiches modifiées** vers les tables `pp_orders`, etc. Envois de quelques Ko, courses impossibles au niveau global, et l'app DBS et PilotPro écriront dans les mêmes tables avec les mêmes règles. Gros chantier — à faire une fois les propositions 1 à 3 en place et la base PostgreSQL en production.

---

## Ma recommandation

**Phase A (le plus rentable tout de suite) : Propositions 1 + 2 ensemble.**
La fusion par champ fait disparaître la cause n°1 des conflits, et le journal des prix apporte l'envoi immédiat, l'accusé de réception, l'historique et la règle automatique en cas de course — le modèle bancaire appliqué là où ça compte le plus pour toi.

**Phase B : Proposition 3 (temps réel), puis 4 (présence).**
**Phase C : Proposition 5**, quand la base PostgreSQL sera en production et l'app DBS avancée.

## Honnêteté sur le mot « définitivement »

Avec les phases A + B, les conflits visibles disparaissent en pratique. Le seul cas restant — deux personnes changeant **le même champ de la même fiche** à quelques secondes d'intervalle — ne bloquera plus personne : le journal tranchera automatiquement (dernière transaction gagne) et l'historique permettra toujours de vérifier et de rétablir. C'est exactement le comportement d'un réseau bancaire : pas « aucune concurrence », mais **aucune perte, jamais**.
