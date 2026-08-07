# 🗄️ PilotPro v3.0 — Passage à PostgreSQL (base partagée par module)

## Ce que ça change, en une phrase

Jusqu'ici, toutes tes données vivaient dans **un seul gros bloc** copié d'un poste à l'autre. Maintenant, le serveur peut les ranger dans une **vraie base PostgreSQL, une table par module** (commandes, clients, façonniers, grand livre, factures…). C'est ce qui permet à l'**application « DBS » de ton ingénieur de partager exactement la même base**.

**Ton application PilotPro n'est pas modifiée.** Le fichier `PilotPro.html` est identique. La fusion fiche-par-fiche, le mode hors-ligne, les rôles, les sauvegardes : tout fonctionne comme avant. Le changement est **uniquement côté serveur**.

## Le principe (rassurant)

- Si tu **ne fais rien**, le serveur continue exactement comme aujourd'hui (fichier `state.json`). Rien ne casse.
- Dès que tu ajoutes **une seule variable** (`DATABASE_URL`), le serveur bascule tout seul en mode PostgreSQL et range les données en tables.
- Chaque commande devient une ligne dans la table `pp_orders`, chaque client une ligne dans `pp_clients`, etc. L'app DBS peut alors lire/écrire ces tables directement.

---

## Étape 1 — Ajouter PostgreSQL sur Railway (2 minutes)

1. Ouvre ton projet sur **railway.app**.
2. Clique sur **« + New »** (ou « Create ») → **« Database »** → **« Add PostgreSQL »**.
3. Railway crée la base et, **automatiquement**, une variable `DATABASE_URL`.

## Étape 2 — Donner l'accès à ton serveur PilotPro

Railway garde chaque service dans son coin. Il faut dire à ton **service PilotPro** d'utiliser la base :

1. Clique sur ton service **PilotPro** (celui qui fait tourner `server.js`).
2. Onglet **« Variables »** → **« + New Variable »**.
3. Nom : `DATABASE_URL`
   Valeur : clique sur **« Add Reference »** et choisis `Postgres → DATABASE_URL`
   *(ça évite de recopier le mot de passe à la main).*
4. Enregistre. Railway redémarre le service tout seul.

> ℹ️ Si le champ « Add Reference » n'apparaît pas, ouvre le service **Postgres**, onglet **Variables**, copie la valeur de `DATABASE_URL` (elle commence par `postgresql://…`) et colle-la dans la variable du service PilotPro.

## Étape 3 — Déployer la v3.0

Remplace `server.js` par la nouvelle version et ajoute les deux fichiers `pgwire.js` et `pgstore.js` à côté (dans le même dossier `pilotpro-server`), puis redéploie comme d'habitude.

Au démarrage, le serveur affiche :

```
Stockage :  PostgreSQL (structuré par module) ✨
```

Si tu lis `Stockage : Fichier …` à la place, c'est que la variable `DATABASE_URL` n'est pas encore vue par le service (revérifie l'étape 2).

## Étape 4 — Importer tes données actuelles (une seule fois)

Deux façons, au choix :

**Le plus simple (depuis un poste).** Une fois la v3.0 en ligne, va sur un poste **qui a déjà toutes les données à jour**, ouvre le menu de synchronisation et clique sur **« Envoyer au serveur »**. Ce simple envoi range automatiquement toutes tes fiches dans les tables PostgreSQL. Vérifie ensuite sur un autre poste (Ctrl+Shift+R) que tout est bien là.

**Le plus sûr (avec vérification automatique).** Récupère le fichier `state.json` actuel (ou une sauvegarde téléchargée depuis l'app), puis lance :

```
DATABASE_URL="postgresql://…"  node migrate-to-postgres.js  state.json
```

Le script importe **et relit** ensuite tout depuis la base pour confirmer, fiche par fiche, que **rien n'a été perdu** avant de te donner le feu vert. Tu peux d'abord faire un essai à blanc avec `--dry-run` (il n'écrit rien, il te montre juste ce qu'il a trouvé).

---

## Pour ton ingénieur (application DBS)

La base est maintenant lisible directement. Deux façons :

- **En SQL** (recommandé pour DBS) : les tables `pp_orders`, `pp_clients`, `pp_faconniers`, `pp_grandlivre`, `pp_factures`, `pp_factures_couts`, `pp_factures_paiements`, `pp_tissus`, `pp_brs`, `pp_coupes`, `pp_chaines`, `pp_operations`… Chaque ligne = une fiche : colonnes `id`, `data` (JSON de la fiche), `updated_at`.
- **En HTTP** (pratique pour tester) :
  - `GET /api/db` → la liste des tables disponibles.
  - `GET /api/db/pp_orders` → toutes les commandes en JSON.

Les compteurs, réglages et journaux (non concernés par le partage) restent dans la table `pp_meta`, sous une forme qui permet de reconstruire à l'identique le bloc attendu par PilotPro.

> **Note technique :** le serveur garantit un aller-retour **identique** (`recompose(decompose(x)) === x`), validé sur tes 286 commandes, 89 factures et 153 comptes du Grand Livre. GPAO Production est aujourd'hui stocké en bloc dans `pp_meta` (structure imbriquée) ; on pourra l'éclater en table `pp_gpao_modeles` dans une prochaine étape si l'app DBS en a besoin.

---

## En cas de doute

- **Revenir en arrière** est immédiat : supprime la variable `DATABASE_URL`, le serveur repasse en mode fichier. (Tes données du fichier et celles de Postgres sont indépendantes — garde une sauvegarde avant de jongler.)
- Les **sauvegardes automatiques** (horaires + quotidiennes) et le bouton de restauration continuent de fonctionner dans les deux modes.
- La page `/api/health` te dit à tout moment quel stockage est actif (`"backend":"postgres"` ou `"file"`).
