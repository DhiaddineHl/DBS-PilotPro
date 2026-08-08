# 🏦 Nouveauté v3.3 — Fusion par champ + Journal des prix (le modèle bancaire)

C'est la **Phase A** du plan « zéro conflit » (voir PROPOSITIONS_zero_conflit.md) : les deux améliorations les plus rentables, livrées ensemble.

## 1. Fusion par CHAMP — la cause n°1 des conflits éliminée

**Avant.** Si deux personnes modifiaient **la même commande** en même temps — toi le prix, ta collègue le statut — le système déclarait un conflit, alors que vous n'aviez pas touché à la même chose.

**Maintenant.** Quand la même fiche a bougé des deux côtés, le système descend **au niveau des champs** : ton prix ET son statut sont conservés tous les deux, automatiquement, sans interruption pour personne.

**Ce qui reste protégé** (vérifié par les tests, jamais de fusion aveugle) : le **même champ** changé différemment des deux côtés → conflit signalé ; une fiche **supprimée** d'un côté et **modifiée** de l'autre → conflit signalé ; structure inattendue → repli sûr sur l'ancien comportement.

Avec le temps réel de la v3.2 (les postes se voient en ~2 secondes), les conflits visibles deviennent exceptionnels.

## 2. Journal des prix — chaque prix est une transaction, comme à la banque

Chaque attribution ou modification de prix (**prix de vente** et **prix façon**) devient une **transaction horodatée**, envoyée **immédiatement** au serveur (sans attendre les 2,5 secondes de la synchronisation normale) :

```
OF-2026-207 · Prix de vente : 8,20 € → 8,50 € · par MOUNA · le 07/08 à 16:32
```

- **Rien n'est jamais effacé** : le journal est en ajout seul, comme un relevé bancaire. En mode PostgreSQL il vit dans une table protégée (`pp_prix_journal`, jamais touchée par les autres opérations — vérifié par test) ; en mode fichier dans `data/prices.jsonl`.
- **Détection automatique** : peu importe l'écran d'où vient le changement (formulaire commande, passerelle facturation…), toute variation de prix est détectée à l'enregistrement et journalisée.
- **Confirmation visible** : un message « ✓ Prix enregistré au journal serveur — OF-2026-207 » s'affiche dès que le serveur a confirmé. En plus, la synchronisation complète part **tout de suite** (plus d'attente).
- **Serveur injoignable ?** La transaction est mise en **file d'attente locale** et repart automatiquement au retour du réseau — testé.
- **Historique sur chaque commande** : bouton **🕑 Prix** dans « Détails du modèle » (et dans la Traçabilité). On y voit qui a changé quoi, quand, ancienne → nouvelle valeur. Les administrateurs et responsables peuvent **rétablir une ancienne valeur en un clic** — et ce rétablissement est lui-même enregistré au journal.
- **Traçабilité d'audit** : chaque envoi est aussi noté dans le journal d'audit du serveur.

## Comment ça a été vérifié — 53 tests automatisés

- **Fusion par champ** (moteur réel extrait du fichier livré) : le scénario exact « prix ici + statut là-bas » → zéro conflit, les deux modifications conservées ; même champ divergent → conflit ; suppression + modification → conflit ; champs imbriqués (tailles) ; fiches différentes inchangées.
- **Détection des prix** (module réel) : premier passage sans fausse transaction, 8,20 → 8,50 correctement journalisé avec l'auteur, envoi immédiat déclenché, nouvelle commande avec prix attribué détectée, file d'attente hors-ligne puis livraison au retour du serveur.
- **Serveur** : transactions acceptées/rejetées correctement dans les deux modes de stockage ; **le journal survit aux enregistrements d'état en PostgreSQL** ; la table du journal est protégée en lecture générique.
- **Régressions** : 10 tests bout-en-bout PostgreSQL + 14 tests temps réel rejoués — tout passe.

## Ce qui ne change pas

- Ton application, tes écrans, tes habitudes : identiques (deux boutons ajoutés, c'est tout).
- Les données existantes : intactes. Le journal démarre à partir de cette version (les changements antérieurs n'y figurent pas).
- Le serveur reste compatible avec les anciens postes le temps du déploiement.

## Où en est le plan « zéro conflit »

✅ Temps réel (v3.2) · ✅ Fusion par champ (v3.3) · ✅ Journal des prix (v3.3)
Prochaines étapes possibles : **présence** (« MOUNA modifie cette commande ») et, à terme, **écriture fiche par fiche** vers PostgreSQL avec l'app DBS.
