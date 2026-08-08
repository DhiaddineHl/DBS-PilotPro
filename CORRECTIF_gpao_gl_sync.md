# 🔒 Correctif v3.4 — Le travail GPAO / Grand Livre / Facturation part TOUJOURS au serveur

## Le problème que vous viviez

Le travail saisi dans **GPAO Production**, **Grand Livre** ou **Facturation HT** restait parfois uniquement sur le poste de l'agent — même en appuyant sur « Enregistrer ». Le bouton enregistrait bien **sur le poste**, mais l'envoi vers le serveur pouvait ne jamais partir.

## La cause exacte (trouvée et reproduite en test)

Ces trois modules tournent dans des **cadres séparés** du menu principal. Leurs enregistrements ne préviennent pas directement la synchronisation : celle-ci les détectait par un **contrôle périodique**, qui comparait les données à une **empreinte de référence**.

Le maillon faible : cette empreinte est une **copie complète des données**. Quand le stockage du navigateur était plein (les photos…), l'empreinte ne pouvait plus s'écrire — **en silence** — et la détection devenait **totalement inopérante** : plus rien ne signalait le travail des modules comme « à envoyer ».

Et le pire : au démarrage suivant, le poste voyait « le serveur a une version différente, et je n'ai rien à envoyer » → il **remplaçait les données locales par celles du serveur**. Le travail de l'agent était perdu (seule une copie de secours interne le gardait, mais personne ne le savait).

## Les trois verrous posés (chacun suffirait seul)

**1. Notification directe.** Chaque enregistrement dans GPAO, Grand Livre ou Facturation prévient maintenant **immédiatement et directement** la synchronisation du menu principal — plus aucune dépendance au contrôle périodique ni aux mécanismes fragiles du navigateur. La saisie part au serveur dans les secondes qui suivent, comme les prix.

**2. Empreinte de secours par hachage.** En plus de l'empreinte complète, une empreinte **minuscule** (quelques octets par module) est toujours écrite — même stockage plein. Si l'empreinte complète échoue, la détection continue de fonctionner via le hachage. Testé : stockage saturé + saisie Grand Livre → détectée quand même.

**3. Filet anti-écrasement au démarrage.** Avant TOUTE décision de mise à jour, le poste re-vérifie maintenant s'il existe des saisies locales non signalées. S'il y en a, elles partent en **fusion automatique** (fiche par fiche, champ par champ) au lieu d'être écrasées. Le scénario exact de la perte a été reproduit en test : avant → travail remplacé ; maintenant → travail détecté, fusionné, envoyé.

## En plus : vos agents VOIENT maintenant l'état serveur

Un **badge permanent** s'affiche en bas à gauche de chaque module :

- 🟢 **✓ Enregistré au serveur** — tout est parti, on peut fermer tranquille
- 🟡 **✎ Envoi au serveur…** — en cours, attendre 2-3 secondes
- 🔴 **⚠ Serveur injoignable** — le travail est gardé sur le poste et partira au retour du réseau
- 🟣 **Conflit** — ouvrir le menu principal

Consigne simple pour l'équipe : **avant de quitter le module, vérifier que le badge est vert.** (Et même en l'oubliant, l'envoi de fermeture automatique et le filet anti-écrasement protègent le travail.)

## Vérifié par les tests

- **15 tests** sur ces correctifs, dont la **reproduction exacte du scénario de perte** (travail GPAO non signalé + stockage plein + redémarrage) : le travail est détecté, fusionné, jamais écrasé.
- **Régressions complètes** : 23 tests Phase A (fusion par champ + journal des prix), 14 tests temps réel, 27 tests v3.1 — tout passe.

## Ce qui ne change pas

Vos écrans, vos données, le serveur : inchangés (seul le fichier de l'application est modifié). Le bouton « Enregistrer » des modules fait exactement ce qu'il faisait — il est simplement, enfin, **relié en direct** à l'envoi serveur.
