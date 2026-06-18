# Déployer PilotPro sur Railway

Votre serveur PilotPro est prêt pour Railway. Comptez ~10 minutes.

> ⚠️ **LE POINT LE PLUS IMPORTANT — la persistance des données.**
> Sur Railway, le disque est **éphémère** : à chaque redéploiement, les fichiers
> sont remis à zéro. **Sans Volume, vous perdez toutes vos données à chaque mise à jour.**
> L'étape 3 (Volume) n'est donc PAS optionnelle.

---

## Étape 1 — Mettre le projet sur GitHub (méthode recommandée)

1. Créez un dépôt GitHub (privé de préférence) : https://github.com/new
2. Envoyez-y le contenu de ce dossier (`server.js`, `package.json`, le dossier `public/`).
   - En ligne de commande :
     ```
     git init
     git add .
     git commit -m "PilotPro serveur"
     git branch -M main
     git remote add origin https://github.com/VOTRE-COMPTE/pilotpro.git
     git push -u origin main
     ```
   - Ou par glisser-déposer via le bouton **« uploading an existing file »** sur GitHub.

## Étape 2 — Créer le service sur Railway

1. Allez sur https://railway.com → **New Project** → **Deploy from GitHub repo**.
2. Choisissez votre dépôt `pilotpro`.
3. Railway détecte automatiquement Node.js (via `package.json`), installe et lance
   `npm start`. Aucune configuration de build à faire.
4. Le port est géré tout seul : le serveur écoute la variable `PORT` fournie par Railway.

## Étape 3 — Ajouter un Volume (OBLIGATOIRE pour garder les données)

1. Dans votre service Railway, faites un **clic droit sur le canvas** (ou ⌘K / Ctrl-K)
   → **Add Volume** / **New Volume**.
2. **Mount path** (point de montage) : tapez exactement `/data`
3. Allez dans l'onglet **Variables** du service et ajoutez :
   ```
   DATA_DIR = /data
   ```
   (C'est ce qui dit au serveur d'écrire ses données dans le Volume persistant.)
4. Si vous voyez plus tard une erreur d'écriture (permissions), ajoutez aussi la variable :
   ```
   RAILWAY_RUN_UID = 0
   ```

> Avec le Volume + `DATA_DIR=/data`, le fichier `state.json` vit dans le Volume et
> **survit à tous les redéploiements et mises à jour.**

## Étape 4 — Générer l'adresse publique

1. Onglet **Settings** du service → section **Networking** → **Generate Domain**.
2. Railway crée une URL du type `https://pilotpro-production-xxxx.up.railway.app`
   (HTTPS automatique).
3. Donnez cette adresse à vos utilisateurs : ils ouvrent, se connectent
   (admin / admin123 au premier lancement), et **tout leur travail s'enregistre
   sur le serveur, partagé entre tous.**

---

## Méthode alternative : sans GitHub (CLI Railway)

Depuis ce dossier, sur votre PC (Node.js installé) :
```
npx @railway/cli@latest login
npx @railway/cli@latest init
npx @railway/cli@latest up
npx @railway/cli@latest domain
```
Puis faites quand même l'**Étape 3 (Volume + DATA_DIR)** dans le dashboard Railway.

---

## Mettre à jour l'application plus tard

- **Méthode GitHub** : poussez vos changements (`git push`) → Railway redéploie tout seul.
  Grâce au Volume, les données sont conservées.
- Remplacez `public/PilotPro.html` par la nouvelle version que je vous livre, commit + push.

## Sauvegardes

- Railway propose des **backups du Volume** (onglet du Volume → Backups : manuel ou planifié).
- Vous pouvez aussi récupérer le `state.json` via la CLI :
  `npx @railway/cli@latest volume` (commande `files`/`browse`).

## Récapitulatif des réglages Railway

| Réglage | Valeur |
|---|---|
| Build / Start | automatique (`npm start`) |
| Variable `PORT` | gérée par Railway (ne pas y toucher) |
| **Volume — Mount path** | `/data` |
| **Variable `DATA_DIR`** | `/data` |
| Variable `RAILWAY_RUN_UID` | `0` (seulement si erreur de permission) |
| Domaine | Settings → Networking → Generate Domain |

---

DBS Fashion — PilotPro · déploiement Railway
